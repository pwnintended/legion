import { up as init } from './001_init';
import { up as prArchiveReport } from './002_pr_archive_report';
import { up as projects } from './003_projects';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/** Ordered, append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', up: init },
  { version: 2, name: 'pr_archive_report', up: prArchiveReport },
  { version: 3, name: 'projects', up: projects },
];
