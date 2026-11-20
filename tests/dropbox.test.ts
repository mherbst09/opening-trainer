import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { TrainerDB } from '../src/db/db';
import { DropboxProvider, dropboxArg, pkceChallenge, randomVerifier, SYNC_PATH } from '../src/sync/dropbox';
import { AuthError, OfflineError } from '../src/sync/types';
import type { SyncFile } from '../src/engine/types';

type Call = { url: string; init: RequestInit };
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const emptyFile: SyncFile = { schema: 1, deviceId: 'd', exportedAt: 1, cards: [], reviewLogs: [], sets: [], settings: null, importedOpenings: [] };

function setup(handler: Handler, now = 1_000_000) {
  const calls: Call[] = [];
  const navigated: string[] = [];
  const db = new TrainerDB(`dbx-${Math.random()}`);
  const p = new DropboxProvider({
    appKey: 'APPKEY',
    db,
    storage: memoryStorage(),
    navigate: (u) => navigated.push(u),
    now: () => now,
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { p, db, calls, navigated };
}

async function loggedIn(handler: Handler, now = 1_000_000) {
  const s = setup(handler, now);
  await s.db.meta.put({ key: 'dropbox:auth', value: { accessToken: 'AT', refreshToken: 'RT', expiresAt: now + 3_600_000 } });
  return s;
}

describe('PKCE helpers', () => {
  it('matches the RFC 7636 S256 test vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('verifier uses only unreserved characters and valid length', () => {
    const v = randomVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });
  it('escapes non-ASCII in Dropbox-API-Arg', () => {
    expect(dropboxArg({ path: '/Zürich.json' })).toBe('{"path":"/Z\\u00fcrich.json"}');
  });
});

describe('Dropbox login', () => {
  it('redirects to authorize with PKCE + offline access, then exchanges the code', async () => {
    const { p, navigated, calls } = setup((url) => {
      expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
      return json(200, { access_token: 'AT', expires_in: 14400, refresh_token: 'RT', account_id: 'acc' });
    });
    expect(await p.status()).toBe('logged-out');
    await p.login('http://localhost:5173/', '#/settings');
    const u = new URL(navigated[0]);
    expect(u.origin + u.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'APPKEY', response_type: 'code', redirect_uri: 'http://localhost:5173/',
      code_challenge_method: 'S256', token_access_type: 'offline',
    });
    const state = u.searchParams.get('state')!;

    const r = await p.handleRedirect(`?code=CODE&state=${state}`);
    expect(r).toEqual({ returnHash: '#/settings' });
    const body = new URLSearchParams(calls[0].init.body as URLSearchParams);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'authorization_code', code: 'CODE', client_id: 'APPKEY', redirect_uri: 'http://localhost:5173/',
    });
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(body.has('client_secret')).toBe(false);
    expect(await p.status()).toBe('logged-in');
  });

  it('rejects a wrong state and a denied consent; ignores unrelated URLs', async () => {
    const { p, navigated } = setup(() => json(200, {}));
    expect(await p.handleRedirect('?foo=1')).toBeNull();
    await p.login('http://localhost:5173/', '');
    await expect(p.handleRedirect('?code=X&state=nope')).rejects.toBeInstanceOf(AuthError);
    await p.login('http://localhost:5173/', '');
    const state = new URL(navigated[1]).searchParams.get('state');
    await expect(p.handleRedirect(`?error=access_denied&state=${state}`)).rejects.toThrow(/not granted/);
  });

  it('not configured without an app key', async () => {
    const p = new DropboxProvider({ appKey: '', db: new TrainerDB(`x-${Math.random()}`), storage: memoryStorage(), navigate: () => {} });
    expect(await p.status()).toBe('not-configured');
  });
});

describe('Dropbox files', () => {
  it('pull: missing file -> null', async () => {
    const { p } = await loggedIn(() => json(409, { error_summary: 'path/not_found/..', error: { '.tag': 'path' } }));
    expect(await p.pull()).toBeNull();
  });

  it('pull: metadata then download of that exact revision', async () => {
    const { p, calls } = await loggedIn((url) =>
      url.endsWith('get_metadata') ? json(200, { rev: 'r42', name: 'x' }) : new Response(JSON.stringify(emptyFile), { status: 200 }));
    const r = await p.pull();
    expect(r?.rev).toBe('r42');
    expect(r?.file.schema).toBe(1);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ path: SYNC_PATH });
    expect((calls[1].init.headers as Record<string, string>)['Dropbox-API-Arg']).toBe('{"path":"rev:r42"}');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  it('push: add when new, update with rev otherwise; conflicts are reported', async () => {
    let status = 200;
    const { p, calls } = await loggedIn(() => (status === 200 ? json(200, { rev: 'r2' }) : json(409, { error_summary: 'path/conflict/file/..' })));
    expect(await p.push(emptyFile, null)).toEqual({ ok: true, rev: 'r2' });
    expect(JSON.parse((calls[0].init.headers as Record<string, string>)['Dropbox-API-Arg'])).toMatchObject({ path: SYNC_PATH, mode: 'add', autorename: false });
    status = 409;
    expect(await p.push(emptyFile, 'r1')).toEqual({ ok: false, conflict: true });
    expect(JSON.parse((calls[1].init.headers as Record<string, string>)['Dropbox-API-Arg']).mode).toEqual({ '.tag': 'update', update: 'r1' });
  });

  it('refreshes an expired token without a client secret and keeps the refresh token', async () => {
    const now = 5_000_000;
    const s = setup((url) =>
      url.includes('oauth2/token') ? json(200, { access_token: 'AT2', expires_in: 14400 }) : json(409, { error_summary: 'path/not_found/' }), now);
    await s.db.meta.put({ key: 'dropbox:auth', value: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: now - 1 } });
    await s.p.pull();
    const body = Object.fromEntries(new URLSearchParams(s.calls[0].init.body as URLSearchParams));
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'APPKEY' });
    expect((s.calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer AT2');
    expect((await s.db.meta.get('dropbox:auth'))?.value).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT' });
  });

  it('revoked refresh token -> AuthError and credentials cleared', async () => {
    const now = 5_000_000;
    const s = setup(() => json(400, { error: 'invalid_grant' }), now);
    await s.db.meta.put({ key: 'dropbox:auth', value: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: now - 1 } });
    await expect(s.p.pull()).rejects.toBeInstanceOf(AuthError);
    expect(await s.p.status()).toBe('logged-out');
  });

  it('network failure -> OfflineError; 5xx/429 -> OfflineError (retry later)', async () => {
    const a = await loggedIn(() => { throw new TypeError('Failed to fetch'); });
    await expect(a.p.pull()).rejects.toBeInstanceOf(OfflineError);
    const b = await loggedIn(() => json(503, {}));
    await expect(b.p.pull()).rejects.toBeInstanceOf(OfflineError);
  });

  it('logout clears credentials and revokes the token', async () => {
    const { p, calls } = await loggedIn(() => json(200, {}));
    await p.logout();
    expect(calls[0].url).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
    expect(await p.status()).toBe('logged-out');
  });
});
