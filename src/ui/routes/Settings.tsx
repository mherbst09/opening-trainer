import { useEffect, useState } from 'react';
import { repo } from '../../db/repo';
import { applySyncFile, exportSyncFile } from '../../sync/localStore';
import { parseSyncFile } from '../../sync/merge';
import { dropbox, sync, takeLoginError, useSyncStatus } from '../../sync/instance';
import { formatWhen } from '../quizSession';
import { useAppData } from '../data';
import type { Settings as SettingsT } from '../../engine/types';

export function SyncStatusText({ short = false }: { short?: boolean }) {
  const s = useSyncStatus();
  const when = s.lastSyncAt ? formatAgo(s.lastSyncAt) : 'never';
  const text: Record<string, string> = {
    disabled: short ? 'Local only' : 'Cloud sync is not set up in this build (no Dropbox app key).',
    'needs-login': short ? 'Not synced' : 'Not connected. Your progress is stored on this device only.',
    idle: short ? (s.pending ? 'Changes pending' : `Synced ${when}`) : `Synced ${when}${s.pending ? ' · local changes waiting' : ''}.`,
    syncing: 'Syncing…',
    offline: short ? 'Offline' : `Offline. Changes are kept and will sync when you are back online. Last sync: ${when}.`,
    error: short ? 'Sync error' : `Sync problem: ${s.error ?? 'unknown error'}`,
  };
  return <span className={`sync-${s.state}`}>{text[s.state]}</span>;
}

function formatAgo(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

export function Settings() {
  const data = useAppData();
  const status = useSyncStatus();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    const e = takeLoginError();
    if (e) setMessage(e);
  }, []);

  const connected = status.state !== 'disabled' && status.state !== 'needs-login';

  const connect = async () => {
    setMessage(null);
    try {
      await dropbox.login();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    await dropbox.logout();
    await sync.reset();
    setBusy(false);
    setConfirmLogout(false);
    setMessage('Disconnected from Dropbox. Your data stays on this device; the file in Dropbox is not deleted.');
  };

  const exportBackup = async () => {
    const f = await exportSyncFile();
    const blob = new Blob([JSON.stringify(f, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `opening-trainer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importBackup = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    try {
      const parsed = parseSyncFile(JSON.parse(await file.text()));
      const { changedLocal, merged } = await applySyncFile(parsed);
      setMessage(changedLocal
        ? `Backup merged: ${merged.cards.length} positions with progress, ${merged.reviewLogs.length} reviews in total.`
        : 'Backup contained nothing new.');
      if (changedLocal) void sync.notifyLocalChange('user'); // push the merged state to the cloud too
    } catch (e) {
      setMessage(`Could not import backup: ${(e as Error).message}`);
    }
  };

  const set = (patch: Partial<SettingsT>) => void repo.saveSettings(patch);
  const st = data.settings;

  return (
    <div className="page setup">
      <h1>Settings</h1>
      {message && <p className="notice" role="status">{message}</p>}

      <section className="card">
        <h2 className="tight">Cloud sync (Dropbox)</h2>
        <p className="small"><SyncStatusText /></p>
        {status.state === 'disabled' ? (
          <p className="muted small">To enable sync, set <code>VITE_DROPBOX_APP_KEY</code> when building the app (see README, “Dropbox setup”).</p>
        ) : connected ? (
          <>
            <p className="muted small">Progress is stored in your own Dropbox, in <code>Apps/…/opening-trainer-sync.json</code>. Each person connects their own account.</p>
            <div className="btn-row wrap">
              <button className="btn primary" disabled={status.state === 'syncing'} onClick={() => void sync.syncNow()}>Sync now</button>
              {confirmLogout ? (
                <>
                  <button className="btn danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
                  <button className="btn" onClick={() => setConfirmLogout(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn" onClick={() => setConfirmLogout(true)}>Disconnect…</button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="muted small">Connect your Dropbox to keep progress in sync between your phone and computer. The app only gets access to its own folder.</p>
            <button className="btn primary" onClick={() => void connect()}>Connect Dropbox</button>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="tight">Backup</h2>
        <p className="muted small">Download all progress, review history, sets, settings and imported openings as JSON. Importing a backup merges it with what is here; nothing is overwritten with older data.</p>
        <div className="btn-row wrap">
          <button className="btn" onClick={() => void exportBackup()}>Export backup</button>
          <label className="btn file-btn">
            <input type="file" accept=".json,application/json" onChange={(e) => { void importBackup(e.target.files?.[0]); e.target.value = ''; }} />
            Import backup…
          </label>
        </div>
      </section>

      <section className="card">
        <h2 className="tight">Preferences</h2>
        <div className="field">
          <span>Theme</span>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} className={`seg-btn ${st.theme === t ? 'on' : ''}`} role="radio" aria-checked={st.theme === t}
                onClick={() => set({ theme: t })}>{{ system: 'Auto', light: 'Light', dark: 'Dark' }[t]}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>New positions per day</span>
          <input type="number" min={0} max={200} value={st.newCardsPerDay} inputMode="numeric"
            onChange={(e) => set({ newCardsPerDay: Math.max(0, Math.min(200, Number(e.target.value) || 0)) })} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={st.stopAtFirstMistake} onChange={(e) => set({ stopAtFirstMistake: e.target.checked })} aria-label="Full line recall: stop at the first mistake" />
          <span>Full line recall: stop at the first mistake</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={st.countPracticeReviews} onChange={(e) => set({ countPracticeReviews: e.target.checked })} aria-label="Practice sessions also reschedule positions that are not due" />
          <span>“Practice all” also reschedules positions that are not due yet</span>
        </label>
      </section>

      <p className="muted small">Next due: {nextDue(data)}</p>
    </div>
  );
}

function nextDue(data: ReturnType<typeof useAppData>): string {
  const now = Date.now();
  let t: number | undefined;
  for (const p of data.progress.values()) if (p.srs.dueAt > now && (t === undefined || p.srs.dueAt < t)) t = p.srs.dueAt;
  return t ? formatWhen(t, now) : '—';
}
