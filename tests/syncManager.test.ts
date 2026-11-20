import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { TrainerDB } from '../src/db/db';
import { Repo } from '../src/db/repo';
import { SyncManager } from '../src/sync/syncManager';
import { exportSyncFile } from '../src/sync/localStore';
import { fingerprint } from '../src/sync/merge';
import { AuthError, OfflineError, type ProviderStatus, type PushResult, type RemoteFile, type SyncProvider } from '../src/sync/types';
import type { SyncFile } from '../src/engine/types';
import { buildCards } from '../src/engine/cards';
import { indexOpening } from '../src/engine/tree';
import { opening } from './helpers';

const cards = buildCards(indexOpening(opening('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *', 'white', 'it')));
const T = Date.UTC(2026, 10, 20, 12);

/** In-memory cloud with Dropbox-like revisions. */
class FakeCloud {
  file: SyncFile | null = null;
  rev = 0;
  pushes = 0;
  /** runs once right before the next push (simulates another device writing) */
  beforeNextPush: (() => void) | null = null;
}

class FakeProvider implements SyncProvider {
  name = 'fake';
  state: ProviderStatus = 'logged-in';
  fail: Error | null = null;
  constructor(public cloud: FakeCloud) {}
  async status() { return this.state; }
  async login() { this.state = 'logged-in'; }
  async logout() { this.state = 'logged-out'; }
  async pull(): Promise<RemoteFile | null> {
    if (this.fail) throw this.fail;
    return this.cloud.file ? { file: structuredClone(this.cloud.file), rev: String(this.cloud.rev) } : null;
  }
  async push(file: SyncFile, rev: string | null): Promise<PushResult> {
    if (this.fail) throw this.fail;
    const hook = this.cloud.beforeNextPush;
    this.cloud.beforeNextPush = null;
    hook?.();
    const current = this.cloud.file ? String(this.cloud.rev) : null;
    if (current !== rev) return { ok: false, conflict: true };
    this.cloud.file = structuredClone(file);
    this.cloud.rev++;
    this.cloud.pushes++;
    return { ok: true, rev: String(this.cloud.rev) };
  }
}

function device(cloud: FakeCloud, online = { value: true }) {
  const db = new TrainerDB(`s-${Math.random()}`);
  const provider = new FakeProvider(cloud);
  const manager = new SyncManager(provider, db, { isOnline: () => online.value, debounceMs: 5 });
  return { db, repo: new Repo(db), provider, manager, online };
}

describe('sync manager', () => {
  it('first device creates the file; second device merges; both converge', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud);
    const b = device(cloud);
    await a.repo.recordReview(cards[0], 3, 'next-move', T);
    await b.repo.recordReview(cards[1], 3, 'next-move', T + 1);

    expect((await a.manager.syncNow()).state).toBe('idle');
    expect(cloud.pushes).toBe(1);
    expect((await b.manager.syncNow()).state).toBe('idle');
    expect(cloud.pushes).toBe(2);
    await a.manager.syncNow(); // pulls b's change, nothing new to push
    expect(cloud.pushes).toBe(2);

    const fa = await exportSyncFile(a.db);
    const fb = await exportSyncFile(b.db);
    expect(fingerprint(fa)).toBe(fingerprint(fb));
    expect(fingerprint(fa)).toBe(fingerprint(cloud.file!));
    expect(fa.cards).toHaveLength(2);
    expect(a.manager.status.lastSyncAt).not.toBeNull();
  });

  it('retries when another device writes between pull and push', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud);
    const b = device(cloud);
    await b.repo.recordReview(cards[1], 3, 'next-move', T);
    await b.manager.syncNow();
    await a.repo.recordReview(cards[0], 3, 'next-move', T + 1);
    await b.repo.recordReview(cards[2], 1, 'next-move', T + 2);
    // b pushes while a is mid-sync
    let bPushed = false;
    cloud.beforeNextPush = () => {
      bPushed = true;
      // simulate b's write landing first
      cloud.file = { ...cloud.file!, reviewLogs: [...cloud.file!.reviewLogs, { id: 'remote-log', cardId: cards[2].id, rating: 1, mode: 'next-move', at: T + 2, before: null }] };
      cloud.rev++;
    };
    const s = await a.manager.syncNow();
    expect(bPushed).toBe(true);
    expect(s.state).toBe('idle');
    const fa = await exportSyncFile(a.db);
    expect(fa.reviewLogs.map((l) => l.id)).toContain('remote-log');
    expect(cloud.file!.reviewLogs.map((l) => l.id)).toContain('remote-log');
    expect(cloud.file!.cards.map((c) => c.id)).toContain(cards[0].id);
  });

  it('offline: keeps pending changes and syncs when back online', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud, { value: false });
    await a.manager.init();
    await a.repo.recordReview(cards[0], 3, 'next-move', T);
    await a.manager.notifyLocalChange('user');
    expect(a.manager.status.pending).toBe(true);
    expect((await a.manager.syncNow()).state).toBe('offline');
    expect(cloud.file).toBeNull();

    a.online.value = true;
    const s = await a.manager.syncNow();
    expect(s).toMatchObject({ state: 'idle', pending: false });
    expect(cloud.file!.cards).toHaveLength(1);
  });

  it('network failure mid-sync -> offline; expired login -> needs-login; logged out -> needs-login', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud);
    a.provider.fail = new OfflineError('fetch failed');
    expect((await a.manager.syncNow()).state).toBe('offline');
    a.provider.fail = new AuthError('Dropbox access was revoked');
    expect(await a.manager.syncNow()).toMatchObject({ state: 'needs-login', error: 'Dropbox access was revoked' });
    a.provider.fail = null;
    a.provider.state = 'logged-out';
    expect((await a.manager.syncNow()).state).toBe('needs-login');
  });

  it('refuses a cloud file from a newer app version without touching local data', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud);
    await a.repo.recordReview(cards[0], 3, 'next-move', T);
    cloud.file = { schema: 99 } as unknown as SyncFile;
    cloud.rev = 7;
    const s = await a.manager.syncNow();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/newer version/);
    expect((await a.repo.progressMap()).size).toBe(1);
  });

  it('debounces user changes, ignores sync-originated changes, single-flights concurrent calls', async () => {
    const cloud = new FakeCloud();
    const a = device(cloud);
    await a.manager.init();
    await a.manager.notifyLocalChange('sync');
    expect(a.manager.status.pending).toBe(false);
    await a.repo.recordReview(cards[0], 3, 'next-move', T);
    await a.manager.notifyLocalChange('user');
    await a.manager.notifyLocalChange('user');
    await new Promise((r) => setTimeout(r, 40));
    await a.manager.syncNow();
    expect(cloud.pushes).toBe(1);
    const [s1, s2] = await Promise.all([a.manager.syncNow(), a.manager.syncNow()]);
    expect(s1.state).toBe('idle');
    expect(s2.state).toBe('idle');
  });
});
