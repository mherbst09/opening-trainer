import type { SyncFile } from '../engine/types';

export type ProviderStatus = 'not-configured' | 'logged-out' | 'logged-in';

export interface RemoteFile {
  file: SyncFile;
  rev: string;
}

export type PushResult = { ok: true; rev: string } | { ok: false; conflict: true };

/** A cloud backend that stores one sync file per user. */
export interface SyncProvider {
  readonly name: string;
  status(): Promise<ProviderStatus>;
  /** May navigate away (OAuth redirect). */
  login(): Promise<void>;
  logout(): Promise<void>;
  /** The current remote file, or null if there is none yet. */
  pull(): Promise<RemoteFile | null>;
  /** Write the file; `rev` null = create. Reports a conflict if the remote changed since `rev`. */
  push(file: SyncFile, rev: string | null): Promise<PushResult>;
}

/** Network unreachable; try again later. */
export class OfflineError extends Error {}
/** Credentials missing, expired or revoked; the user must connect again. */
export class AuthError extends Error {}
