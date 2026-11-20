// Dropbox sync provider: OAuth 2 PKCE in the browser (no client secret, no server),
// "App folder" access, refresh tokens. Endpoints per docs.dropboxapi.com (checked 2026-11-20).
import { db as defaultDb, type TrainerDB } from '../db/db';
import type { SyncFile } from '../engine/types';
import { AuthError, OfflineError, type ProviderStatus, type PushResult, type RemoteFile, type SyncProvider } from './types';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';
const METADATA_URL = 'https://api.dropboxapi.com/2/files/get_metadata';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';

/** Inside the app folder (Apps/<app name>/ in the user's Dropbox). */
export const SYNC_PATH = '/opening-trainer-sync.json';
const AUTH_KEY = 'dropbox:auth';
const PKCE_KEY = 'dropbox:pkce';

interface StoredAuth {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
}

interface PendingLogin {
  verifier: string;
  state: string;
  redirectUri: string;
  returnHash: string;
}

export interface DropboxOptions {
  appKey: string | undefined;
  db?: TrainerDB;
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  navigate?: (url: string) => void;
  now?: () => number;
}

// ---------- PKCE helpers ----------

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomVerifier(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const rnd = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(rnd, (b) => chars[b % chars.length]).join('');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Dropbox-API-Arg must be ASCII: escape everything above 0x7E as \uXXXX. */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The page's own URL without query/hash: what must be registered as redirect URI. */
export function currentRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export class DropboxProvider implements SyncProvider {
  readonly name = 'Dropbox';
  private db: TrainerDB;
  private fetchFn: typeof fetch;
  private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private navigate: (url: string) => void;
  private now: () => number;
  private refreshing: Promise<string> | null = null;

  constructor(private opts: DropboxOptions) {
    this.db = opts.db ?? defaultDb;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.storage = opts.storage ?? window.localStorage;
    this.navigate = opts.navigate ?? ((url) => window.location.assign(url));
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.opts.appKey;
  }

  async status(): Promise<ProviderStatus> {
    if (!this.configured) return 'not-configured';
    return (await this.auth()) ? 'logged-in' : 'logged-out';
  }

  private async auth(): Promise<StoredAuth | null> {
    return ((await this.db.meta.get(AUTH_KEY))?.value as StoredAuth | undefined) ?? null;
  }

  private async saveAuth(a: StoredAuth | null) {
    if (a) await this.db.meta.put({ key: AUTH_KEY, value: a });
    else await this.db.meta.delete(AUTH_KEY);
  }

  // ---------- login ----------

  async login(redirectUri = currentRedirectUri(), returnHash = window.location.hash): Promise<void> {
    if (!this.opts.appKey) throw new Error('Dropbox is not configured (VITE_DROPBOX_APP_KEY is missing).');
    const verifier = randomVerifier();
    const state = randomVerifier(24);
    const pending: PendingLogin = { verifier, state, redirectUri, returnHash };
    this.storage.setItem(PKCE_KEY, JSON.stringify(pending));
    const params = new URLSearchParams({
      client_id: this.opts.appKey,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      state,
    });
    this.navigate(`${AUTHORIZE_URL}?${params.toString()}`);
  }

  /**
   * Finish a login after Dropbox redirected back with ?code=&state=. Returns the hash
   * route to restore, or null when the URL is not a Dropbox redirect. Throws on failure.
   */
  async handleRedirect(search: string): Promise<{ returnHash: string } | null> {
    const q = new URLSearchParams(search);
    const code = q.get('code');
    const error = q.get('error');
    const raw = this.storage.getItem(PKCE_KEY);
    if (!code && !error) return null;
    if (!raw) return null; // not our redirect
    const pending = JSON.parse(raw) as PendingLogin;
    this.storage.removeItem(PKCE_KEY);
    if (q.get('state') !== pending.state) throw new AuthError('Dropbox login failed: state mismatch. Please try again.');
    if (error) throw new AuthError(error === 'access_denied' ? 'Dropbox access was not granted.' : `Dropbox login failed: ${q.get('error_description') ?? error}`);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: pending.verifier,
      client_id: this.opts.appKey!,
      redirect_uri: pending.redirectUri,
    });
    const res = await this.request(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) throw new AuthError(`Dropbox login failed (${res.status}): ${await res.text()}`);
    const t = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; account_id?: string };
    if (!t.refresh_token) throw new AuthError('Dropbox did not return a refresh token.');
    await this.saveAuth({
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: this.now() + t.expires_in * 1000,
      accountId: t.account_id,
    });
    return { returnHash: pending.returnHash };
  }

  async logout(): Promise<void> {
    const a = await this.auth();
    await this.saveAuth(null);
    if (!a) return;
    try {
      // Revokes the access token and the refresh token it came from.
      const token = a.expiresAt - 60_000 > this.now() ? a.accessToken : await this.refreshWith(a);
      await this.request(REVOKE_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {
      // Best effort: local credentials are already gone.
    }
  }

  // ---------- tokens ----------

  private async accessToken(): Promise<string> {
    const a = await this.auth();
    if (!a) throw new AuthError('Not connected to Dropbox.');
    if (a.expiresAt - 60_000 > this.now()) return a.accessToken;
    this.refreshing ??= this.refreshWith(a).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshWith(a: StoredAuth): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: this.opts.appKey! });
    const res = await this.request(TOKEN_URL, { method: 'POST', body });
    if (res.status === 400 || res.status === 401) {
      await this.saveAuth(null);
      throw new AuthError('Dropbox access expired or was revoked. Connect again.');
    }
    if (!res.ok) throw new Error(`Dropbox token refresh failed (${res.status})`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    // The refresh response does not include a new refresh token; keep the old one.
    await this.saveAuth({ ...a, accessToken: t.access_token, expiresAt: this.now() + t.expires_in * 1000 });
    return t.access_token;
  }

  /** fetch that maps network failures to OfflineError. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (e) {
      throw new OfflineError(`Network error: ${(e as Error).message}`);
    }
  }

  /** Authorized call; on 401 refresh once and retry. */
  private async api(url: string, init: RequestInit): Promise<Response> {
    const call = async (token: string) =>
      this.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    let res = await call(await this.accessToken());
    if (res.status === 401) {
      const a = await this.auth();
      if (!a) throw new AuthError('Not connected to Dropbox.');
      res = await call(await this.refreshWith({ ...a, expiresAt: 0 }));
      if (res.status === 401) {
        await this.saveAuth(null);
        throw new AuthError('Dropbox access was revoked. Connect again.');
      }
    }
    if (res.status === 429 || res.status >= 500) throw new OfflineError(`Dropbox is busy (${res.status}); will retry.`);
    return res;
  }

  // ---------- files ----------

  async pull(): Promise<RemoteFile | null> {
    // Read metadata first, then download exactly that revision, so the rev we later
    // update against always matches the content we merged.
    const meta = await this.api(METADATA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: SYNC_PATH }),
    });
    if (meta.status === 409) {
      const err = (await meta.json().catch(() => ({}))) as { error_summary?: string };
      if (err.error_summary?.startsWith('path/not_found')) return null;
      throw new Error(`Dropbox metadata error: ${err.error_summary ?? meta.status}`);
    }
    if (!meta.ok) throw new Error(`Dropbox metadata error (${meta.status})`);
    const { rev } = (await meta.json()) as { rev: string };

    const dl = await this.api(DOWNLOAD_URL, { method: 'POST', headers: { 'Dropbox-API-Arg': dropboxArg({ path: `rev:${rev}` }) } });
    if (dl.status === 409) return null; // deleted in between: treat as absent; push with rev=null creates it
    if (!dl.ok) throw new Error(`Dropbox download error (${dl.status})`);
    const text = await dl.text();
    let file: SyncFile;
    try {
      file = JSON.parse(text) as SyncFile;
    } catch {
      throw new Error('The sync file in Dropbox is not valid JSON. Delete it from the app folder to start fresh.');
    }
    return { file, rev };
  }

  async push(file: SyncFile, rev: string | null): Promise<PushResult> {
    const arg = {
      path: SYNC_PATH,
      mode: rev ? { '.tag': 'update', update: rev } : 'add',
      autorename: false,
      mute: true,
      strict_conflict: true,
    };
    const res = await this.api(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dropboxArg(arg) },
      body: JSON.stringify(file),
    });
    if (res.status === 409) {
      const err = (await res.json().catch(() => ({}))) as { error_summary?: string };
      if (err.error_summary?.includes('conflict')) return { ok: false, conflict: true };
      throw new Error(`Dropbox upload error: ${err.error_summary ?? res.status}`);
    }
    if (!res.ok) throw new Error(`Dropbox upload error (${res.status})`);
    const meta = (await res.json()) as { rev: string };
    return { ok: true, rev: meta.rev };
  }
}
