// Merging two sync files. Pure functions: commutative, associative and idempotent,
// so devices can sync in any order, any number of times.
import { SYNC_SCHEMA_VERSION, type CardProgress, type Opening, type ReviewLogEntry, type Settings, type StudySet, type SyncFile } from '../engine/types';

/** Card progress: the most recent review wins (ties: more reps, then newer write). */
export function newerCard(a: CardProgress, b: CardProgress): CardProgress {
  const ra = a.srs.lastReviewAt ?? -1;
  const rb = b.srs.lastReviewAt ?? -1;
  if (ra !== rb) return ra > rb ? a : b;
  if (a.srs.reps !== b.srs.reps) return a.srs.reps > b.srs.reps ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableKey(a) >= stableKey(b) ? a : b; // deterministic for identical timestamps
}

/** Sets, imported openings, settings: newest updatedAt wins; tombstones are ordinary entries. */
export function newerByUpdatedAt<T extends { updatedAt: number; deleted?: boolean }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b; // same instant: deletion wins
  return stableKey(a) >= stableKey(b) ? a : b;
}

function stableKey(x: unknown): string {
  return JSON.stringify(x);
}

function mergeById<T extends { id: string }>(a: T[], b: T[], pick: (x: T, y: T) => T): T[] {
  const out = new Map<string, T>();
  for (const x of a) out.set(x.id, out.has(x.id) ? pick(out.get(x.id)!, x) : x);
  for (const y of b) out.set(y.id, out.has(y.id) ? pick(out.get(y.id)!, y) : y);
  return [...out.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function mergeCards(a: CardProgress[], b: CardProgress[]) {
  return mergeById(a, b, newerCard);
}
export function mergeLogs(a: ReviewLogEntry[], b: ReviewLogEntry[]) {
  return mergeById(a, b, (x) => x); // logs are immutable: union by id
}
export function mergeSets(a: StudySet[], b: StudySet[]) {
  return mergeById(a, b, newerByUpdatedAt);
}
export function mergeOpenings(a: Opening[], b: Opening[]) {
  return mergeById(a, b, newerByUpdatedAt);
}
export function mergeSettings(a: Settings | null, b: Settings | null): Settings | null {
  if (!a || !b) return a ?? b;
  return newerByUpdatedAt(a, b);
}

export function mergeSyncFiles(local: SyncFile, remote: SyncFile, deviceId = local.deviceId, now = Date.now()): SyncFile {
  return {
    schema: SYNC_SCHEMA_VERSION,
    deviceId,
    exportedAt: now,
    cards: mergeCards(local.cards, remote.cards),
    reviewLogs: mergeLogs(local.reviewLogs, remote.reviewLogs),
    sets: mergeSets(local.sets, remote.sets),
    settings: mergeSettings(local.settings, remote.settings),
    importedOpenings: mergeOpenings(local.importedOpenings, remote.importedOpenings),
  };
}

/** Content identity ignoring envelope fields (deviceId, exportedAt) and order. */
export function fingerprint(f: SyncFile): string {
  const ids = <T extends { id: string }>(xs: T[], stamp: (x: T) => unknown) =>
    xs.map((x) => `${x.id}:${String(stamp(x))}`).sort().join(',');
  return [
    ids(f.cards, (c) => `${c.srs.lastReviewAt}/${c.srs.reps}/${c.updatedAt}`),
    ids(f.reviewLogs, () => ''),
    ids(f.sets, (s) => `${s.updatedAt}/${s.deleted ? 1 : 0}`),
    ids(f.importedOpenings, (o) => `${o.updatedAt}/${o.deleted ? 1 : 0}`),
    f.settings ? String(f.settings.updatedAt) : '-',
  ].join('|');
}

export class SchemaTooNewError extends Error {
  constructor(public version: number) {
    super(`The synced data was written by a newer version of the app (schema ${version}). Update this app first.`);
  }
}

/** Validate and upgrade a parsed sync/backup file. Throws on garbage or a newer schema. */
export function parseSyncFile(raw: unknown): SyncFile {
  if (!raw || typeof raw !== 'object') throw new Error('Not a sync file');
  const f = raw as Partial<SyncFile> & { schema?: number };
  if (typeof f.schema !== 'number') throw new Error('Not a sync file (missing schema)');
  if (f.schema > SYNC_SCHEMA_VERSION) throw new SchemaTooNewError(f.schema);
  // schema 1 is the first version; future migrations go here (if f.schema < N ...).
  const arr = <T>(x: T[] | undefined, name: string): T[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw new Error(`Invalid sync file: ${name} is not a list`);
    return x;
  };
  return {
    schema: SYNC_SCHEMA_VERSION,
    deviceId: String(f.deviceId ?? 'unknown'),
    exportedAt: Number(f.exportedAt ?? 0),
    cards: arr(f.cards, 'cards').filter((c) => c && typeof c.id === 'string' && c.srs),
    reviewLogs: arr(f.reviewLogs, 'reviewLogs').filter((l) => l && typeof l.id === 'string'),
    sets: arr(f.sets, 'sets').filter((s) => s && typeof s.id === 'string'),
    settings: f.settings ?? null,
    importedOpenings: arr(f.importedOpenings, 'importedOpenings').filter((o) => o && typeof o.id === 'string' && o.root),
  };
}
