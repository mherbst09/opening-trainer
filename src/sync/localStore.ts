// Reading and writing the sync file against IndexedDB. Built-in content is never synced.
import { db as defaultDb, type TrainerDB } from '../db/db';
import { emitChange } from '../db/repo';
import { SYNC_SCHEMA_VERSION, type Settings, type SyncFile } from '../engine/types';
import { fingerprint, mergeSyncFiles } from './merge';

export async function deviceIdOf(db: TrainerDB): Promise<string> {
  const row = await db.meta.get('deviceId');
  if (row) return row.value as string;
  const id = crypto.randomUUID();
  await db.meta.put({ key: 'deviceId', value: id });
  return id;
}

/** Everything that syncs, including tombstones. */
export async function exportSyncFile(db: TrainerDB = defaultDb, now = Date.now()): Promise<SyncFile> {
  const deviceId = await deviceIdOf(db);
  return db.transaction('r', [db.progress, db.reviewLogs, db.sets, db.openings, db.meta], async () => {
    const [cards, reviewLogs, sets, importedOpenings, settingsRow] = await Promise.all([
      db.progress.toArray(), db.reviewLogs.toArray(), db.sets.toArray(), db.openings.toArray(), db.meta.get('settings'),
    ]);
    const settings = (settingsRow?.value as Settings | undefined) ?? null;
    return { schema: SYNC_SCHEMA_VERSION, deviceId, exportedAt: now, cards, reviewLogs, sets, settings, importedOpenings };
  });
}

/**
 * Merge `incoming` into the local database atomically and return the merged file.
 * The merge runs inside the write transaction against the rows present at that moment,
 * so a review recorded while a sync is in flight is never overwritten.
 */
export async function applySyncFile(incoming: SyncFile, db: TrainerDB = defaultDb, now = Date.now()): Promise<{ merged: SyncFile; changedLocal: boolean }> {
  const deviceId = await deviceIdOf(db);
  const result = await db.transaction('rw', [db.progress, db.reviewLogs, db.sets, db.openings, db.meta], async () => {
    const [cards, reviewLogs, sets, importedOpenings, settingsRow] = await Promise.all([
      db.progress.toArray(), db.reviewLogs.toArray(), db.sets.toArray(), db.openings.toArray(), db.meta.get('settings'),
    ]);
    const local: SyncFile = {
      schema: SYNC_SCHEMA_VERSION, deviceId, exportedAt: now, cards, reviewLogs, sets, importedOpenings,
      settings: (settingsRow?.value as Settings | undefined) ?? null,
    };
    const merged = mergeSyncFiles(local, incoming, deviceId, now);
    const changedLocal = fingerprint(merged) !== fingerprint(local);
    if (changedLocal) {
      await db.progress.bulkPut(merged.cards);
      await db.reviewLogs.bulkPut(merged.reviewLogs);
      await db.sets.bulkPut(merged.sets);
      await db.openings.bulkPut(merged.importedOpenings);
      if (merged.settings) await db.meta.put({ key: 'settings', value: merged.settings });
    }
    return { merged, changedLocal };
  });
  if (result.changedLocal) emitChange('sync');
  return result;
}
