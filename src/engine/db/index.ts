import { migrate } from './migrate';
import { type Database, openDatabase } from './sqlite';
import { Store, type StoreOptions } from './store';

export { migrate, schemaVersion } from './migrate';
export { MIGRATIONS } from './migrations';
export { type Database, openDatabase, pragma } from './sqlite';
export * from './store';

export interface OpenedStore {
  db: Database;
  store: Store;
  schemaVersion: number;
  close(): void;
}

/** Open the database at `path`, apply migrations and wrap it in a Store. */
export function openStore(path: string, options: StoreOptions = {}): OpenedStore {
  const db = openDatabase(path);
  try {
    const version = migrate(db);
    return {
      db,
      store: new Store(db, options),
      schemaVersion: version,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
