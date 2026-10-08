import { up as init } from './001_init';
import { up as prArchiveReport } from './002_pr_archive_report';
import { up as attachments } from './003_attachments';
import { up as projects } from './004_projects';
import { up as messages } from './005_messages';
import { up as presentations } from './006_presentations';
import { up as localMerge } from './007_local_merge';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/** Ordered, append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', up: init },
  { version: 2, name: 'pr_archive_report', up: prArchiveReport },
  { version: 3, name: 'attachments', up: attachments },
  { version: 4, name: 'projects', up: projects },
  { version: 5, name: 'messages', up: messages },
  { version: 6, name: 'presentations', up: presentations },
  { version: 7, name: 'local_merge', up: localMerge },
];
