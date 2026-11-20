import { describe, it, expect } from 'vitest';
import {
  fingerprint, mergeSyncFiles, newerCard, parseSyncFile, SchemaTooNewError,
} from '../src/sync/merge';
import type { CardProgress, Opening, ReviewLogEntry, Settings, SrsState, StudySet, SyncFile } from '../src/engine/types';
import { opening } from './helpers';

const srs = (lastReviewAt: number | null, reps: number): SrsState => ({
  stability: reps, stabilityFast: reps, difficulty: 5, state: 2, scheduleStatus: 'review',
  dueAt: (lastReviewAt ?? 0) + 86_400_000, lastReviewAt, reps, lapses: 0, scheduledDays: 1, learningStep: 0,
});
const card = (id: string, lastReviewAt: number, reps: number, updatedAt = lastReviewAt): CardProgress =>
  ({ id, openingId: id.split('|')[0], posKey: id.split('|')[1], srs: srs(lastReviewAt, reps), updatedAt });
const log = (id: string, cardId: string, at: number): ReviewLogEntry =>
  ({ id, cardId, rating: 3, mode: 'next-move', at, before: null });
const set = (id: string, name: string, updatedAt: number, deleted = false): StudySet =>
  ({ id, name, openingIds: deleted ? [] : ['italian'], updatedAt, deleted: deleted || undefined });
const settings = (updatedAt: number, theme: Settings['theme']): Settings =>
  ({ theme, stopAtFirstMistake: false, newCardsPerDay: 20, countPracticeReviews: false, updatedAt });
const imported = (id: string, name: string, updatedAt: number, deleted = false): Opening =>
  ({ ...opening('1. e4 c6 *', 'black', id), name, source: 'imported', updatedAt, deleted: deleted || undefined });

const file = (p: Partial<SyncFile>): SyncFile => ({
  schema: 1, deviceId: 'd', exportedAt: 0, cards: [], reviewLogs: [], sets: [], settings: null, importedOpenings: [], ...p,
});

describe('merge rules', () => {
  it('cards: newest lastReview wins, ties by reps then updatedAt', () => {
    expect(newerCard(card('o|a', 10, 1), card('o|a', 20, 1)).srs.lastReviewAt).toBe(20);
    expect(newerCard(card('o|a', 10, 3), card('o|a', 10, 2)).srs.reps).toBe(3);
    expect(newerCard(card('o|a', 10, 2, 5), card('o|a', 10, 2, 9)).updatedAt).toBe(9);
  });

  it('logs are a union by id; sets/openings/settings newest updatedAt; tombstones win when newer', () => {
    const a = file({
      reviewLogs: [log('l1', 'o|a', 1), log('l2', 'o|a', 2)],
      sets: [set('s1', 'Old name', 1), set('s2', 'Keep', 5)],
      importedOpenings: [imported('i1', 'Caro', 1)],
      settings: settings(10, 'dark'),
    });
    const b = file({
      reviewLogs: [log('l2', 'o|a', 2), log('l3', 'o|b', 3)],
      sets: [set('s1', 'New name', 2), set('s2', 'Keep', 4, true)], // older deletion loses
      importedOpenings: [imported('i1', 'Caro', 2, true)], // newer deletion wins
      settings: settings(5, 'light'),
    });
    const m = mergeSyncFiles(a, b);
    expect(m.reviewLogs.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(m.sets.find((s) => s.id === 's1')?.name).toBe('New name');
    expect(m.sets.find((s) => s.id === 's2')?.deleted).toBeUndefined();
    expect(m.importedOpenings[0].deleted).toBe(true);
    expect(m.settings?.theme).toBe('dark');
  });

  it('same-instant edit vs delete: deletion wins on both devices', () => {
    const a = file({ sets: [set('s', 'x', 7)] });
    const b = file({ sets: [set('s', 'x', 7, true)] });
    expect(mergeSyncFiles(a, b).sets[0].deleted).toBe(true);
    expect(mergeSyncFiles(b, a).sets[0].deleted).toBe(true);
  });
});

describe('two devices editing offline', () => {
  // Shared starting point synced to both devices.
  const base = file({
    cards: [card('o|p1', 100, 1), card('o|p2', 100, 1)],
    reviewLogs: [log('l0', 'o|p1', 100), log('l00', 'o|p2', 100)],
    sets: [set('s1', 'This week', 100)],
  });

  // Phone (offline): reviews p1 at 200, renames the set at 210, creates s2.
  const phone = file({
    ...base,
    deviceId: 'phone',
    cards: [card('o|p1', 200, 2), card('o|p2', 100, 1)],
    reviewLogs: [...base.reviewLogs, log('phone-1', 'o|p1', 200)],
    sets: [set('s1', 'Week 47', 210), set('s2', 'Gambits', 220)],
  });
  // PC (offline): reviews p1 at 150 and p2 at 300, deletes the set at 250, imports an opening.
  const pc = file({
    ...base,
    deviceId: 'pc',
    cards: [card('o|p1', 150, 2), card('o|p2', 300, 2), card('o|p3', 310, 1)],
    reviewLogs: [...base.reviewLogs, log('pc-1', 'o|p1', 150), log('pc-2', 'o|p2', 300), log('pc-3', 'o|p3', 310)],
    sets: [set('s1', 'This week', 250, true)],
    importedOpenings: [imported('i1', 'Caro', 260)],
  });

  it('both devices end up with the same, complete state', () => {
    const atPhone = mergeSyncFiles(phone, pc, 'phone', 1);
    const atPc = mergeSyncFiles(pc, phone, 'pc', 2);
    expect(fingerprint(atPhone)).toBe(fingerprint(atPc));

    // newest review per position
    expect(atPhone.cards.map((c) => [c.id, c.srs.lastReviewAt])).toEqual([['o|p1', 200], ['o|p2', 300], ['o|p3', 310]]);
    // nothing lost from the history
    expect(atPhone.reviewLogs.map((l) => l.id).sort()).toEqual(['l0', 'l00', 'pc-1', 'pc-2', 'pc-3', 'phone-1']);
    // delete at 250 beats rename at 210; the phone's new set survives
    expect(atPhone.sets.find((s) => s.id === 's1')?.deleted).toBe(true);
    expect(atPhone.sets.find((s) => s.id === 's2')?.name).toBe('Gambits');
    expect(atPhone.importedOpenings.map((o) => o.name)).toEqual(['Caro']);
  });

  it('merging is idempotent and order-independent (associative across three devices)', () => {
    const tablet = file({ deviceId: 'tablet', cards: [card('o|p2', 400, 3)], reviewLogs: [log('t-1', 'o|p2', 400)] });
    const once = mergeSyncFiles(phone, pc);
    expect(fingerprint(mergeSyncFiles(once, once))).toBe(fingerprint(once));
    expect(fingerprint(mergeSyncFiles(once, pc))).toBe(fingerprint(once));
    const left = mergeSyncFiles(mergeSyncFiles(phone, pc), tablet);
    const right = mergeSyncFiles(phone, mergeSyncFiles(pc, tablet));
    expect(fingerprint(left)).toBe(fingerprint(right));
    expect(left.cards.find((c) => c.id === 'o|p2')?.srs.lastReviewAt).toBe(400);
  });

  it('fingerprint ignores envelope fields and order', () => {
    const a = mergeSyncFiles(phone, pc, 'x', 1);
    const b = { ...a, deviceId: 'y', exportedAt: 99, cards: [...a.cards].reverse() };
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(phone));
  });
});

describe('sync file validation', () => {
  it('accepts a valid file and fills missing lists', () => {
    const f = parseSyncFile({ schema: 1, deviceId: 'd', exportedAt: 1, cards: [card('o|a', 1, 1)] });
    expect(f.cards).toHaveLength(1);
    expect(f.reviewLogs).toEqual([]);
    expect(f.settings).toBeNull();
  });
  it('rejects garbage and newer schemas', () => {
    expect(() => parseSyncFile(null)).toThrow();
    expect(() => parseSyncFile({ cards: [] })).toThrow(/schema/);
    expect(() => parseSyncFile({ schema: 1, cards: 'x' })).toThrow(/cards/);
    expect(() => parseSyncFile({ schema: 99 })).toThrow(SchemaTooNewError);
  });
  it('drops malformed rows instead of failing', () => {
    const f = parseSyncFile({ schema: 1, cards: [{ id: 'x' }, card('o|a', 1, 1)], sets: [null, set('s', 'n', 1)] });
    expect(f.cards.map((c) => c.id)).toEqual(['o|a']);
    expect(f.sets.map((s) => s.id)).toEqual(['s']);
  });
});
