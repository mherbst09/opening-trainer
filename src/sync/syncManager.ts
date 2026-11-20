// Orchestrates pull -> merge -> apply -> push, with retries on conflicts, offline
// handling, debouncing and a status that the UI can subscribe to.
import { db as defaultDb, type TrainerDB } from '../db/db';
import type { ChangeSource } from '../db/repo';
import { applySyncFile, exportSyncFile } from './localStore';
import { fingerprint, parseSyncFile, SchemaTooNewError } from './merge';
import { AuthError, OfflineError, type SyncProvider } from './types';

export type SyncState = 'disabled' | 'needs-login' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: number | null;
  error?: string;
  /** local changes not yet pushed */
  pending: boolean;
}

export interface SyncManagerOptions {
  isOnline?: () => boolean;
  now?: () => number;
  debounceMs?: number;
  maxAttempts?: number;
}

const LAST_SYNC_KEY = 'sync:lastSyncAt';
const PENDING_KEY = 'sync:pending';

export class SyncManager {
  private statusValue: SyncStatus = { state: 'disabled', lastSyncAt: null, pending: false };
  private listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<SyncStatus> | null = null;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly isOnline: () => boolean;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxAttempts: number;

  constructor(private provider: SyncProvider, private db: TrainerDB = defaultDb, opts: SyncManagerOptions = {}) {
    this.isOnline = opts.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.statusValue);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>) {
    this.statusValue = { ...this.statusValue, ...patch };
    if (patch.state !== 'error') delete this.statusValue.error;
    if (patch.error) this.statusValue.error = patch.error;
    for (const fn of this.listeners) fn(this.statusValue);
  }

  /** Load persisted status and decide whether sync is available. */
  async init(): Promise<SyncStatus> {
    const [last, pending] = await Promise.all([this.db.meta.get(LAST_SYNC_KEY), this.db.meta.get(PENDING_KEY)]);
    const ps = await this.provider.status();
    this.set({
      lastSyncAt: (last?.value as number | undefined) ?? null,
      pending: !!pending?.value,
      state: ps === 'logged-in' ? 'idle' : ps === 'logged-out' ? 'needs-login' : 'disabled',
    });
    return this.statusValue;
  }

  /** Call for every local DB change. User edits mark the data dirty and schedule a sync. */
  async notifyLocalChange(source: ChangeSource): Promise<void> {
    if (source !== 'user') return;
    if (!this.statusValue.pending) {
      this.set({ pending: true });
      await this.db.meta.put({ key: PENDING_KEY, value: true });
    }
    this.schedule(this.debounceMs);
  }

  schedule(delayMs = 0) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** Run a pending debounced sync right away (e.g. when the page is being hidden). */
  flush() {
    if (this.timer) this.schedule(0);
  }

  /** Single-flight: concurrent calls share one run; a call during a run triggers one more run after it. */
  syncNow(): Promise<SyncStatus> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async run(): Promise<SyncStatus> {
    const ps = await this.provider.status();
    if (ps !== 'logged-in') {
      this.set({ state: ps === 'logged-out' ? 'needs-login' : 'disabled' });
      return this.statusValue;
    }
    if (!this.isOnline()) {
      this.set({ state: 'offline' });
      return this.statusValue;
    }
    this.set({ state: 'syncing' });
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const remote = await this.provider.pull();
        let merged;
        if (remote) {
          const remoteFile = parseSyncFile(remote.file);
          merged = (await applySyncFile(remoteFile, this.db, this.now())).merged;
          if (fingerprint(merged) === fingerprint(remoteFile)) {
            await this.succeeded();
            return this.statusValue;
          }
        } else {
          merged = await exportSyncFile(this.db, this.now());
        }
        const res = await this.provider.push(merged, remote?.rev ?? null);
        if (res.ok) {
          await this.succeeded();
          return this.statusValue;
        }
        // conflict: someone else wrote in between; pull and merge again
      }
      this.set({ state: 'error', error: 'The cloud file kept changing during sync. Will retry later.' });
    } catch (e) {
      if (e instanceof OfflineError) this.set({ state: 'offline' });
      else if (e instanceof AuthError) this.set({ state: 'needs-login', error: e.message });
      else if (e instanceof SchemaTooNewError) this.set({ state: 'error', error: e.message });
      else this.set({ state: 'error', error: (e as Error).message || String(e) });
    }
    return this.statusValue;
  }

  private async succeeded() {
    const at = this.now();
    await this.db.meta.bulkPut([{ key: LAST_SYNC_KEY, value: at }, { key: PENDING_KEY, value: false }]);
    this.set({ state: 'idle', lastSyncAt: at, pending: false });
  }

  /** Forget local sync bookkeeping (on logout). Local data stays. */
  async reset() {
    if (this.timer) clearTimeout(this.timer);
    await this.db.meta.bulkDelete([LAST_SYNC_KEY]);
    this.set({ state: 'needs-login', lastSyncAt: null });
  }
}
