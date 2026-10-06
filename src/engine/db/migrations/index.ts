import { up as init } from './001_init';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/** Ordered, append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', up: init }];
