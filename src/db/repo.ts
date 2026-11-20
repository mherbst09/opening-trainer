import { db as defaultDb, DEFAULT_SETTINGS, type TrainerDB } from './db';
import { getScheduler, reviewSrs, type Grade } from '../engine/scheduler';
import type { Card, CardProgress, Opening, QuizMode, ReviewLogEntry, Settings, StudySet } from '../engine/types';

/** 'user' = a local edit (schedules a sync); 'sync' = data written by a sync (does not). */
export type ChangeSource = 'user' | 'sync';
type Listener = (source: ChangeSource) => void;
const listeners = new Set<Listener>();
/** Notified after every local write (used by the UI to refresh and by sync to debounce). */
export function onLocalChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitChange(source: ChangeSource = 'user') {
  for (const fn of listeners) fn(source);
}

const uuid = () => crypto.randomUUID();

export class Repo {
  constructor(private db: TrainerDB = defaultDb) {}

  async progressMap(): Promise<Map<string, CardProgress>> {
    const rows = await this.db.progress.toArray();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Apply an FSRS review to a card and store progress + log atomically. */
  async recordReview(card: Card, grade: Grade, mode: QuizMode, now = Date.now()): Promise<CardProgress> {
    await getScheduler(); // warm up outside the IndexedDB transaction
    const progress = await this.db.transaction('rw', this.db.progress, this.db.reviewLogs, async () => {
      const existing = await this.db.progress.get(card.id);
      const before = existing?.srs ?? null;
      const srs = await reviewSrs(before ?? undefined, grade, now);
      const p: CardProgress = { id: card.id, openingId: card.openingId, posKey: card.posKey, srs, updatedAt: now };
      const log: ReviewLogEntry = { id: uuid(), cardId: card.id, rating: grade, mode, at: now, before };
      await this.db.progress.put(p);
      await this.db.reviewLogs.add(log);
      return p;
    });
    // Notify only after commit: listeners read other tables, and Dexie would bind
    // their queries to this transaction if called from inside it.
    emitChange();
    return progress;
  }

  async settings(): Promise<Settings> {
    const row = await this.db.meta.get('settings');
    return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch, updatedAt: Date.now() };
    await this.db.meta.put({ key: 'settings', value: next });
    emitChange();
    return next;
  }

  async deviceId(): Promise<string> {
    const row = await this.db.meta.get('deviceId');
    if (row) return row.value as string;
    const id = uuid();
    await this.db.meta.put({ key: 'deviceId', value: id });
    return id;
  }

  // ---------- study sets ----------

  /** Live (non-deleted) sets, alphabetical. */
  async sets(): Promise<StudySet[]> {
    const all = await this.db.sets.toArray();
    return all.filter((s) => !s.deleted).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveSet(input: { id?: string; name: string; openingIds: string[]; lineFilter?: Record<string, string[]> }, now = Date.now()): Promise<StudySet> {
    const set: StudySet = {
      id: input.id ?? uuid(),
      name: input.name.trim() || 'Untitled set',
      openingIds: input.openingIds,
      lineFilter: input.lineFilter && Object.keys(input.lineFilter).length ? input.lineFilter : undefined,
      updatedAt: now,
    };
    await this.db.sets.put(set);
    emitChange();
    return set;
  }

  async renameSet(id: string, name: string, now = Date.now()): Promise<void> {
    const s = await this.db.sets.get(id);
    if (!s || s.deleted) return;
    await this.db.sets.put({ ...s, name: name.trim() || s.name, updatedAt: now });
    emitChange();
  }

  /** Tombstone, so the deletion wins when merging with other devices. */
  async deleteSet(id: string, now = Date.now()): Promise<void> {
    const s = await this.db.sets.get(id);
    if (!s) return;
    await this.db.sets.put({ id, name: s.name, openingIds: [], updatedAt: now, deleted: true });
    emitChange();
  }

  // ---------- imported openings ----------

  async importedOpenings(): Promise<Opening[]> {
    const all = await this.db.openings.toArray();
    return all.filter((o) => !o.deleted).sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveImportedOpening(o: Opening, now = Date.now()): Promise<Opening> {
    const row: Opening = { ...o, source: 'imported', updatedAt: now, deleted: undefined };
    await this.db.openings.put(row);
    emitChange();
    return row;
  }

  /** Tombstone (kept small) so the deletion propagates through sync. Review history stays but is hidden. */
  async deleteImportedOpening(id: string, now = Date.now()): Promise<void> {
    const o = await this.db.openings.get(id);
    if (!o) return;
    await this.db.openings.put({
      ...o, pgn: undefined, root: { id: '', san: '', uci: '', fen: o.root.fen, children: [] }, deleted: true, updatedAt: now,
    });
    emitChange();
  }

  /** Number of new cards introduced today (for the daily new-card cap). */
  async newCardsReviewedToday(now = Date.now()): Promise<number> {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const logs = await this.db.reviewLogs.where('at').aboveOrEqual(start.getTime()).toArray();
    return new Set(logs.filter((l) => l.before === null).map((l) => l.cardId)).size;
  }
}

export const repo = new Repo();
