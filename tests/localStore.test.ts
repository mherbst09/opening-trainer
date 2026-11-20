import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { TrainerDB } from '../src/db/db';
import { Repo, onLocalChange, type ChangeSource } from '../src/db/repo';
import { applySyncFile, exportSyncFile } from '../src/sync/localStore';
import { fingerprint } from '../src/sync/merge';
import { buildCards } from '../src/engine/cards';
import { indexOpening } from '../src/engine/tree';
import { opening } from './helpers';

const cards = buildCards(indexOpening(opening('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *', 'white', 'it')));
const T = Date.UTC(2026, 10, 20, 12);

function device() {
  const db = new TrainerDB(`d-${Math.random()}`);
  return { db, repo: new Repo(db) };
}

describe('local store', () => {
  it('exports everything incl. tombstones and settings', async () => {
    const { db, repo } = device();
    await repo.recordReview(cards[0], 3, 'next-move', T);
    const s = await repo.saveSet({ name: 'A', openingIds: ['it'] }, T);
    await repo.deleteSet(s.id, T + 1);
    await repo.saveSettings({ theme: 'dark' });
    const f = await exportSyncFile(db, T);
    expect(f.cards).toHaveLength(1);
    expect(f.reviewLogs).toHaveLength(1);
    expect(f.sets[0].deleted).toBe(true);
    expect(f.settings?.theme).toBe('dark');
    expect(f.deviceId).toBeTruthy();
  });

  it('two devices converge through apply; sync writes are tagged as sync changes', async () => {
    const a = device();
    const b = device();
    await a.repo.recordReview(cards[0], 3, 'next-move', T);
    await b.repo.recordReview(cards[1], 1, 'full-line', T + 5);
    await b.repo.saveSet({ name: 'B set', openingIds: ['it'] }, T + 6);

    const sources: ChangeSource[] = [];
    const off = onLocalChange((s) => sources.push(s));
    const { merged, changedLocal } = await applySyncFile(await exportSyncFile(b.db, T + 10), a.db, T + 10);
    off();
    expect(changedLocal).toBe(true);
    expect(sources).toEqual(['sync']);
    await applySyncFile(merged, b.db, T + 11);

    const fa = await exportSyncFile(a.db);
    const fb = await exportSyncFile(b.db);
    expect(fingerprint(fa)).toBe(fingerprint(fb));
    expect(fa.cards.map((c) => c.id).sort()).toEqual([cards[0].id, cards[1].id].sort());
    expect(fa.reviewLogs).toHaveLength(2);
    expect(fa.sets.map((s) => s.name)).toEqual(['B set']);

    // applying the same thing again changes nothing
    const again = await applySyncFile(merged, a.db, T + 12);
    expect(again.changedLocal).toBe(false);
  });

  it('a newer local review survives an older incoming state of the same card', async () => {
    const a = device();
    const b = device();
    await b.repo.recordReview(cards[0], 3, 'next-move', T);
    const old = await exportSyncFile(b.db);
    await a.repo.recordReview(cards[0], 1, 'next-move', T + 1000);
    await applySyncFile(old, a.db);
    const after = (await a.repo.progressMap()).get(cards[0].id)!;
    expect(after.srs.lastReviewAt).toBe(T + 1000);
    expect(after.srs.state).toBe(1); // Again on a new card -> Learning (the incoming Good would be Review)
  });
});
