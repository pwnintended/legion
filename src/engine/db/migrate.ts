import { MIGRATIONS, type Migration } from './migrations';
import { type Database, pragma } from './sqlite';

export function schemaVersion(db: Database): number {
  return Number(pragma(db, 'user_version') ?? 0);
}

/**
 * Apply pending migrations, each in its own transaction, tracking progress in `PRAGMA user_version`.
 * Refuses to open a database written by a newer Legion.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = schemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`database schema v${current} is newer than this Legion build (v${latest})`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.up);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`);
    }
  }
  return schemaVersion(db);
}
