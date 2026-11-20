// App-wide sync wiring: one provider, one manager, and the triggers from the spec
// (app open, after a quiz session, debounce after changes, back online).
import { useEffect, useState } from 'react';
import { onLocalChange } from '../db/repo';
import { DropboxProvider } from './dropbox';
import { SyncManager, type SyncStatus } from './syncManager';

export const dropbox = new DropboxProvider({ appKey: import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined });
export const sync = new SyncManager(dropbox);

let started = false;
let loginError: string | null = null;

/** Call once at startup. Finishes a pending Dropbox login, then syncs. */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const r = await dropbox.handleRedirect(window.location.search);
    if (r) window.history.replaceState(null, '', `${window.location.pathname}${r.returnHash || '#/settings'}`);
  } catch (e) {
    loginError = (e as Error).message;
    window.history.replaceState(null, '', `${window.location.pathname}#/settings`);
  }
  onLocalChange((source) => void sync.notifyLocalChange(source));
  window.addEventListener('online', () => void sync.syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sync.flush();
  });
  const s = await sync.init();
  if (s.state === 'idle') void sync.syncNow();
}

/** One-time message from a failed login redirect. */
export function takeLoginError(): string | null {
  const e = loginError;
  loginError = null;
  return e;
}

/** Sync after a finished quiz session (spec trigger). */
export function syncAfterSession() {
  if (sync.status.state !== 'disabled' && sync.status.state !== 'needs-login') void sync.syncNow();
}

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState(sync.status);
  useEffect(() => sync.subscribe(setS), []);
  return s;
}
