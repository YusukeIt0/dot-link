import type { DatabaseSync } from 'node:sqlite';

export interface LocationContinuity {
  erased: string;
  stopped: string;
  /** In-process legacy consent revision, renewed on restart. */
  revision?: string;
}
export function installLocationContinuity(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const marker = db.prepare("SELECT 1 FROM pragma_table_info('observations') WHERE name='archive_generation'").get();
    if (!marker) db.exec('ALTER TABLE observations ADD COLUMN archive_generation TEXT');
    const stamp = db.prepare("SELECT 1 FROM pragma_table_info('observations') WHERE name='archive_stamp'").get();
    if (!stamp) db.exec('ALTER TABLE observations ADD COLUMN archive_stamp TEXT');
    // Released builds update the same v1 JSON consent row. A stop followed by
    // re-enable in an older app must not confer that app's seven-day grant on
    // an existing longer archive. A deletion must also retire its separate key.
    db.exec(`
      CREATE TABLE IF NOT EXISTS history_continuity (
        id INTEGER PRIMARY KEY CHECK(id=1), erased TEXT NOT NULL, stopped TEXT NOT NULL);
      INSERT OR IGNORE INTO history_continuity VALUES(1,lower(hex(randomblob(16))),lower(hex(randomblob(16))));
      CREATE TRIGGER IF NOT EXISTS history_continuity_erase AFTER UPDATE OF data ON state
        WHEN json_extract(OLD.data,'$.owner') IS NOT NULL AND
          json_extract(OLD.data,'$.owner') IS NOT json_extract(NEW.data,'$.owner')
        BEGIN UPDATE history_continuity SET erased=lower(hex(randomblob(16))) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS history_continuity_stop AFTER UPDATE OF data ON state
        WHEN json_extract(OLD.data,'$.enabled')=1 AND json_extract(NEW.data,'$.enabled')=0
        BEGIN UPDATE history_continuity SET stopped=lower(hex(randomblob(16))) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS history_continuity_remove AFTER DELETE ON state
        BEGIN UPDATE history_continuity SET erased=lower(hex(randomblob(16))),stopped=lower(hex(randomblob(16))) WHERE id=1; END;
    `);
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
export type LocationArchiveChange = {action: 'set'; source: 'location'; enabled: boolean} | {action: 'delete'; source: 'location'};
export interface LocationTransaction {
  path: string;
  apply(db: DatabaseSync): {changed: boolean; marker: LocationContinuity};
  committed(): void;
}
export function locationContinuity(db: DatabaseSync, attached = false): LocationContinuity {
  const table = attached ? 'legacy_history.history_continuity' : 'history_continuity';
  const row = db.prepare(`SELECT erased,stopped FROM ${table} WHERE id=1`).get();
  if (typeof row?.erased !== 'string' || !/^[0-9a-f]{32}$/.test(row.erased) ||
      typeof row.stopped !== 'string' || !/^[0-9a-f]{32}$/.test(row.stopped)) throw new Error('Invalid location history continuity');
  return {erased: row.erased, stopped: row.stopped};
}
