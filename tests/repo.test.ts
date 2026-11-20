import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { TrainerDB } from '../src/db/db';
import { Repo, onLocalChange } from '../src/db/repo';
import { buildCards } from '../src/engine/cards';
import { indexOpening } from '../src/engine/tree';
import { opening } from './helpers';

const cards = buildCards(indexOpening(opening('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *', 'white', 'it')));

describe('repo', () => {
  it('records reviews with logs and keeps progress across reloads', async () => {
    const name = `t-${Math.random()}`;
    const repo = new Repo(new TrainerDB(name));
    const now = Date.UTC(2026, 10, 20, 12);
    await repo.recordReview(cards[0], 3, 'next-move', now);
    const p = await repo.recordReview(cards[0], 1, 'next-move', now + 60_000);
    expect(p.srs.reps).toBe(2);
    expect(p.srs.lapses).toBe(1);

    const reopened = new Repo(new TrainerDB(name));
    const map = await reopened.progressMap();
    expect(map.get(cards[0].id)?.srs.reps).toBe(2);
    expect(await reopened.newCardsReviewedToday(now + 120_000)).toBe(1);
  });

  it('change listeners can read other tables after a review (not bound to the review transaction)', async () => {
    const repo = new Repo(new TrainerDB(`t-${Math.random()}`));
    const seen: Promise<unknown>[] = [];
    const off = onLocalChange(() => seen.push(repo.settings()));
    await repo.recordReview(cards[1], 3, 'next-move', Date.UTC(2026, 10, 20));
    off();
    expect(seen).toHaveLength(1);
    await expect(seen[0]).resolves.toMatchObject({ newCardsPerDay: 20 });
  });

  it('settings default and patch', async () => {
    const repo = new Repo(new TrainerDB(`t-${Math.random()}`));
    expect((await repo.settings()).newCardsPerDay).toBe(20);
    await repo.saveSettings({ theme: 'dark' });
    expect((await repo.settings()).theme).toBe('dark');
    expect(await repo.deviceId()).toBe(await repo.deviceId());
  });
});

describe('imported openings', () => {
  it('save, list, delete as tombstone', async () => {
    const db = new TrainerDB(`t-${Math.random()}`);
    const repo = new Repo(db);
    const o = opening('1. e4 c6 2. d4 d5 *', 'black', 'imp-1');
    await repo.saveImportedOpening({ ...o, name: 'Caro-Kann', pgn: '1. e4 c6 2. d4 d5 *' }, 10);
    const list = await repo.importedOpenings();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'imp-1', name: 'Caro-Kann', source: 'imported', updatedAt: 10 });
    expect(list[0].root.children[0].san).toBe('e4');

    await repo.deleteImportedOpening('imp-1', 20);
    expect(await repo.importedOpenings()).toEqual([]);
    const tomb = await db.openings.get('imp-1');
    expect(tomb).toMatchObject({ deleted: true, updatedAt: 20 });
    expect(tomb?.root.children).toEqual([]);
    expect(tomb?.pgn).toBeUndefined();
  });
});

describe('study sets', () => {
  it('create, rename, update, delete (tombstone)', async () => {
    const db = new TrainerDB(`t-${Math.random()}`);
    const repo = new Repo(db);
    const a = await repo.saveSet({ name: ' White repertoire ', openingIds: ['italian'] }, 1);
    const b = await repo.saveSet({ name: 'This week', openingIds: ['italian'], lineFilter: { italian: ['l1'] } }, 2);
    expect(a.name).toBe('White repertoire');
    expect(a.lineFilter).toBeUndefined();
    expect((await repo.sets()).map((s) => s.name)).toEqual(['This week', 'White repertoire']);

    await repo.renameSet(a.id, 'Whites', 3);
    await repo.saveSet({ ...b, openingIds: ['italian', 'scotch'] }, 4);
    const after = await repo.sets();
    expect(after.find((s) => s.id === a.id)).toMatchObject({ name: 'Whites', updatedAt: 3 });
    expect(after.find((s) => s.id === b.id)).toMatchObject({ openingIds: ['italian', 'scotch'], updatedAt: 4 });

    await repo.deleteSet(a.id, 5);
    expect((await repo.sets()).map((s) => s.id)).toEqual([b.id]);
    expect(await db.sets.get(a.id)).toMatchObject({ deleted: true, updatedAt: 5 });
  });
});
