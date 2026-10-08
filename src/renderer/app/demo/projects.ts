/**
 * Demo projects (renderer only): the repositories behind the demo runs, as small virtual checkouts with files,
 * history and pull requests, answering `projects.*`, `files.*`, `git.log`, `git.show`, `prs.list` and commit
 * diffs. Deterministic for a given `now`, so screenshots are stable.
 */
import type { Project, Run } from '@shared/domain';
import { fuzzyRank } from '@shared/fuzzy';
import { imageMimeOf, languageOfPath } from '@shared/languages';
import type {
  Commit,
  CommitDiff,
  DiffFile,
  FileContent,
  FileEntry,
  FileList,
  PrList,
  ProjectInfo,
  ProjectStatus,
  SearchResult,
} from '@shared/rpc';
import { RpcError } from '@shared/rpc-transport';
import { parseHunks } from './diffs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A 1×1 PNG and a small logo, so the image preview has something to show.
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 24 24">
  <rect x="2" y="6" width="5.5" height="14" rx="1.6" fill="#cba6f7" opacity="0.55"/>
  <rect x="9.25" y="3" width="5.5" height="18" rx="1.6" fill="#cba6f7"/>
  <rect x="16.5" y="6" width="5.5" height="14" rx="1.6" fill="#94e2d5" opacity="0.8"/>
</svg>
`;

const APP_README = `# erudiet/app

The Erudiet web app: course pages, checkout, accounts and the teacher dashboard.
React 19 + Vite on the front, a small Hono server, Postgres through Drizzle.

![Erudiet](public/logo.svg)

## Getting started

\`\`\`sh
pnpm install
pnpm db:up        # Postgres in Docker
pnpm dev          # http://localhost:5173
\`\`\`

## Layout

| Folder | What lives there |
|---|---|
| \`src/\` | The React app: routes, settings, billing, UI kit |
| \`server/\` | API routes, auth (sessions + WebAuthn), migrations |
| \`docs/\` | Architecture notes and the [passkeys design](docs/passkeys.md) |

## Conventions

- Every route has a loader test next to it.
- Migrations are append-only; \`pnpm db:check\` runs in CI.
- Money is integer cents end to end. Never floats.

## Releasing

Tag \`vX.Y.Z\` on \`main\`; CI builds and deploys the tag. See \`docs/architecture.md\` for the
deploy topology.
`;

const PASSKEYS_MD = `# Passkeys

Sign in with WebAuthn, next to the existing email link.

1. **Registration**: \`POST /auth/webauthn/register/options\` returns a challenge (kept 5 min in Redis),
   the browser calls \`navigator.credentials.create()\`, we verify and store the credential.
2. **Authentication**: same dance with \`get()\`; the sign counter must increase.
3. **Settings**: a passkey list where people can name and remove their keys.

> Credentials are bound to \`erudiet.com\`; preview deploys use a separate RP id.
`;

const WEBAUTHN_TS = `import { generateAuthenticationOptions, generateRegistrationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/types';
import { challenges } from './session';
import type { PasskeyCredential } from './contracts';

const RP_NAME = 'Erudiet';
const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface RelyingParty {
  id: string;
  origin: string;
}

/** Options for navigator.credentials.create(); the challenge is kept for five minutes. */
export async function registrationOptions(rp: RelyingParty, user: { id: string; email: string }, existing: PasskeyCredential[]) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.id,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await challenges.put(user.id, options.challenge, CHALLENGE_TTL_SECONDS);
  return options;
}

/** Options for navigator.credentials.get(). */
export async function authenticationOptions(rp: RelyingParty, userId: string | null) {
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'preferred' });
  if (userId) await challenges.put(userId, options.challenge, CHALLENGE_TTL_SECONDS);
  return options;
}

/** A sign counter must strictly increase (0 means the authenticator doesn't count). */
export function counterIsValid(stored: bigint, received: number): boolean {
  if (received === 0 && stored === 0n) return true;
  return BigInt(received) > stored;
}
`;

const PASSKEY_LIST_TSX = `import { useState } from 'react';
import { Button } from '../ui/Button';
import { startPasskeyRegistration } from '../auth/webauthn';
import { usePasskeys } from './usePasskeys';

export function PasskeyList() {
  const { passkeys, refresh, remove } = usePasskeys();
  const [adding, setAdding] = useState(false);

  async function add() {
    setAdding(true);
    try {
      await startPasskeyRegistration();
      await refresh();
    } finally {
      setAdding(false);
    }
  }

  return (
    <section aria-labelledby="passkeys-title">
      <h2 id="passkeys-title">Passkeys</h2>
      <p className="muted">Sign in with Touch ID, Face ID or a security key.</p>
      <ul>
        {passkeys.map((key) => (
          <li key={key.id}>
            <span>{key.name ?? 'Unnamed passkey'}</span>
            <span className="muted">added {key.createdAt.toLocaleDateString()}</span>
            <Button variant="ghost" onClick={() => remove(key.id)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Button onClick={add} disabled={adding}>
        {adding ? 'Waiting for your device…' : 'Add a passkey'}
      </Button>
    </section>
  );
}
`;

const PACKAGE_JSON = `{
  "name": "@erudiet/app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "lint": "biome check .",
    "db:up": "docker compose up -d postgres",
    "db:check": "drizzle-kit check"
  },
  "dependencies": {
    "@simplewebauthn/browser": "13.1.0",
    "@simplewebauthn/server": "13.1.1",
    "drizzle-orm": "0.44.2",
    "hono": "4.8.3",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.15",
    "typescript": "7.0.2",
    "vite": "7.3.7",
    "vitest": "5.0.3"
  }
}
`;

const MIGRATION_SQL = `-- 0042: passkeys
CREATE TABLE passkey_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id  bytea NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  name           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX passkey_credentials_user ON passkey_credentials (user_id);
`;

function code(name: string, body: string[]): string {
  return `// ${name}\n${body.join('\n')}\n`;
}

const APP_FILES: Record<string, string> = {
  'README.md': APP_README,
  'package.json': PACKAGE_JSON,
  'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: 19.3.0\n        version: 19.3.0\n`,
  'tsconfig.json': `{\n  "compilerOptions": {\n    "target": "ES2023",\n    "module": "ESNext",\n    "moduleResolution": "Bundler",\n    "jsx": "react-jsx",\n    "strict": true\n  },\n  "include": ["src", "server"]\n}\n`,
  '.gitignore': 'node_modules/\ndist/\n.env\n*.log\n',
  'legion.json': `{\n  "setup": ["pnpm install --frozen-lockfile"],\n  "verify": ["pnpm lint", "pnpm test"],\n  "highRiskGlobs": ["server/db/migrations/**"]\n}\n`,
  'biome.json': `{\n  "formatter": { "indentStyle": "space", "lineWidth": 110 }\n}\n`,
  'docs/architecture.md': `# Architecture\n\nOne Vite app, one Hono server, one Postgres.\n\n- Sessions live in Redis (14 days, sliding).\n- Billing talks to Stripe through \`server/billing\`.\n- Background jobs run on the queue worker (\`server/jobs\`).\n`,
  'docs/passkeys.md': PASSKEYS_MD,
  'public/logo.svg': LOGO_SVG,
  'public/og.png': '',
  'src/main.tsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './app/App';\nimport './ui/theme.css';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  'src/app/App.tsx': `import { RouterProvider } from './router';\nimport { routes } from './routes';\n\nexport function App() {\n  return <RouterProvider routes={routes} />;\n}\n`,
  'src/app/routes.ts': `import { lazy } from 'react';\n\nexport const routes = [\n  { path: '/', component: lazy(() => import('../pages/Home')) },\n  { path: '/courses/:slug', component: lazy(() => import('../pages/Course')) },\n  { path: '/checkout', component: lazy(() => import('../billing/Checkout')) },\n  { path: '/settings', component: lazy(() => import('../settings/Settings')) },\n];\n`,
  'src/app/router.tsx': code('router.tsx', ['export { RouterProvider } from "@erudiet/router";']),
  'src/auth/contracts.ts': `/** Shared WebAuthn types (T1 of the passkeys run). */\nexport interface PasskeyCredential {\n  id: string;\n  userId: string;\n  credentialId: Uint8Array;\n  publicKey: Uint8Array;\n  signCount: bigint;\n  transports: string[];\n  name: string | null;\n  createdAt: Date;\n}\n\nexport type RegistrationResult =\n  | { ok: true; credential: PasskeyCredential }\n  | { ok: false; reason: 'challenge_expired' | 'verification_failed' };\n`,
  'src/auth/session.ts': `import { redis } from '../../server/redis';\n\nexport const challenges = {\n  put: (userId: string, challenge: string, ttl: number) => redis.set(\`wa:\${userId}\`, challenge, 'EX', ttl),\n  take: async (userId: string) => {\n    const value = await redis.getdel(\`wa:\${userId}\`);\n    return value ?? null;\n  },\n};\n`,
  'src/auth/webauthn.ts': WEBAUTHN_TS,
  'src/auth/webauthn.test.ts': `import { describe, expect, it } from 'vitest';\nimport { counterIsValid } from './webauthn';\n\ndescribe('counterIsValid', () => {\n  it('requires a strictly increasing counter', () => {\n    expect(counterIsValid(5n, 6)).toBe(true);\n    expect(counterIsValid(5n, 5)).toBe(false);\n  });\n\n  it('accepts authenticators that never count', () => {\n    expect(counterIsValid(0n, 0)).toBe(true);\n  });\n});\n`,
  'src/settings/PasskeyList.tsx': PASSKEY_LIST_TSX,
  'src/settings/Settings.tsx': `import { PasskeyList } from './PasskeyList';\nimport { Profile } from './Profile';\n\nexport default function Settings() {\n  return (\n    <main className="settings">\n      <Profile />\n      <PasskeyList />\n    </main>\n  );\n}\n`,
  'src/settings/Profile.tsx': code('Profile.tsx', [
    'export function Profile() {',
    '  return <section>Profile</section>;',
    '}',
  ]),
  'src/settings/usePasskeys.ts': code('usePasskeys.ts', [
    "import { useCallback, useEffect, useState } from 'react';",
    '',
    'export function usePasskeys() {',
    '  const [passkeys, setPasskeys] = useState<{ id: string; name: string | null; createdAt: Date }[]>([]);',
    "  const refresh = useCallback(async () => setPasskeys(await (await fetch('/api/passkeys')).json()), []);",
    '  useEffect(() => void refresh(), [refresh]);',
    "  const remove = async (id: string) => { await fetch('/api/passkeys/' + id, { method: 'DELETE' }); await refresh(); };",
    '  return { passkeys, refresh, remove };',
    '}',
  ]),
  'src/billing/Checkout.tsx': code('Checkout.tsx', [
    'export default function Checkout() {',
    '  return <main>Checkout</main>;',
    '}',
  ]),
  'src/billing/invoice.ts': code('invoice.ts', [
    'export interface Invoice {',
    '  id: string;',
    '  number: string;',
    '  totalCents: number;',
    "  currency: 'EUR' | 'USD';",
    '}',
  ]),
  'src/billing/pdf.ts': code('pdf.ts', [
    'export async function renderInvoicePdf(): Promise<Uint8Array> {',
    '  return new Uint8Array();',
    '}',
  ]),
  'src/ui/Button.tsx': `import type { ButtonHTMLAttributes } from 'react';\n\nexport function Button({ variant = 'primary', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }) {\n  return <button className={\`btn btn-\${variant}\`} {...rest} />;\n}\n`,
  'src/ui/theme.css': `:root {\n  --bg: #11111b;\n  --text: #cdd6f4;\n  --accent: #cba6f7;\n}\n\n.btn {\n  border-radius: 8px;\n  padding: 0 12px;\n}\n`,
  'src/pages/Home.tsx': code('Home.tsx', ['export default function Home() {', '  return <main>Home</main>;', '}']),
  'src/pages/Course.tsx': code('Course.tsx', [
    'export default function Course() {',
    '  return <main>Course</main>;',
    '}',
  ]),
  'server/index.ts': `import { Hono } from 'hono';\nimport { auth } from './auth/routes';\n\nconst app = new Hono();\napp.route('/auth', auth);\n\nexport default app;\n`,
  'server/redis.ts': code('redis.ts', [
    "import Redis from 'ioredis';",
    '',
    'export const redis = new Redis(process.env.REDIS_URL);',
  ]),
  'server/auth/routes.ts': code('routes.ts', [
    "import { Hono } from 'hono';",
    '',
    'export const auth = new Hono();',
    '// TODO: rate-limit the WebAuthn option endpoints',
    "auth.post('/webauthn/register/options', async (c) => c.json({}));",
    "auth.post('/webauthn/authenticate/options', async (c) => c.json({}));",
  ]),
  'server/db/migrations/0041_sessions.sql':
    '-- 0041: sessions\nALTER TABLE sessions ADD COLUMN last_seen_at timestamptz;\n',
  'server/db/migrations/0042_passkeys.sql': MIGRATION_SQL,
  'scripts/seed.ts': code('seed.ts', [
    "import { db } from '../server/db';",
    '',
    'await db.insert(users).values({ email: "demo@erudiet.com" });',
  ]),
};

const IMAGE_FILES: Record<string, string> = {
  'public/og.png': DOT_PNG,
};

function smallRepo(name: string, readme: string, files: Record<string, string>): Record<string, string> {
  return {
    'README.md': `# erudiet/${name}\n\n${readme}\n`,
    'package.json': `{\n  "name": "@erudiet/${name}",\n  "private": true\n}\n`,
    '.gitignore': 'node_modules/\ndist/\n',
    ...files,
  };
}

const REPOS: Record<string, Record<string, string>> = {
  app: APP_FILES,
  web: smallRepo('web', 'The marketing site and docs: Astro, MDX and the design tokens.', {
    'src/pages/index.astro':
      '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="Erudiet">\n  <h1>Learn anything, properly.</h1>\n</Layout>\n',
    'src/layouts/Layout.astro':
      '---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title></head><body><slot /></body></html>\n',
    'src/styles/tokens.css': ':root {\n  --mauve: #cba6f7;\n  --teal: #94e2d5;\n}\n',
    'src/i18n/en.json': '{\n  "nav.courses": "Courses",\n  "nav.pricing": "Pricing"\n}\n',
  }),
  api: smallRepo('api', 'Background jobs and the public API (Go).', {
    'cmd/worker/main.go':
      'package main\n\nimport "github.com/erudiet/api/internal/jobs"\n\nfunc main() {\n\tjobs.Run()\n}\n',
    'internal/jobs/cron.go': 'package jobs\n\n// Run starts the cron scheduler.\nfunc Run() {}\n',
    'internal/queue/queue.go': 'package queue\n\ntype Job struct {\n\tID   string\n\tKind string\n}\n',
    'go.mod': 'module github.com/erudiet/api\n\ngo 1.25\n',
  }),
};

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

const AUTHORS = [
  { name: 'Bas', email: 'bas@erudiet.com' },
  { name: 'Mira Okafor', email: 'mira@erudiet.com' },
  { name: 'Jonas Weber', email: 'jonas@erudiet.com' },
  { name: 'legion', email: 'legion@localhost' },
];

const APP_SUBJECTS = [
  'Passkeys: enrollment UI in settings',
  'Passkeys: registration API and challenge store',
  'Auth contracts & types for WebAuthn',
  'Bump vite to 7.3.7',
  'Checkout: show VAT per line',
  'Fix flaky course page loader test',
  'Invoice PDF export (#398)',
  'Release v2.3.0',
  'Settings: profile photo upload',
  'Sessions: sliding expiry, 14 days',
  'Teacher dashboard: weekly digest email',
  'Course page: lazy-load the syllabus',
  'Stripe: retry webhooks with backoff',
  'Docs: deploy topology',
  'UI kit: Button variants',
  'Remove the old feature flag service',
  'Migrations: 0041 sessions.last_seen_at',
  'Search: debounce course search',
  'Billing: integer cents everywhere',
  'Accessibility pass on checkout',
  'CI: cache pnpm store',
  'Course progress ring',
  'i18n groundwork',
  'Upgrade to React 19.3',
  'Hono server: structured logging',
  'Fix timezone bug in digest',
  'Add seed script',
  'Initial import',
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shaOf(seed: string): string {
  let out = '';
  for (let i = 0; out.length < 40; i++) out += hash(`${seed}:${i}`).toString(16).padStart(8, '0');
  return out.slice(0, 40);
}

function historyOf(name: string, now: number): Commit[] {
  const subjects = name === 'app' ? APP_SUBJECTS : [`${name}: tidy up`, `${name}: dependency bumps`, 'Initial import'];
  let at = now - 38 * MIN;
  const commits: Commit[] = subjects.map((subject, i) => {
    const author =
      AUTHORS[subject.startsWith('Passkeys') || subject.startsWith('Auth') ? 3 : hash(subject) % 3] ?? AUTHORS[0];
    const commit: Commit = {
      sha: shaOf(`${name}:${i}`),
      shortSha: shaOf(`${name}:${i}`).slice(0, 7),
      parents: [],
      author: author?.name ?? 'Bas',
      authorEmail: author?.email ?? '',
      date: at,
      subject,
      refs: [],
    };
    at -= (0.6 + (hash(subject) % 100) / 18) * HOUR + (i > 10 ? DAY : 0);
    return commit;
  });
  commits.forEach((c, i) => {
    const parent = commits[i + 1];
    c.parents = parent ? [parent.sha] : [];
  });
  const head = commits[0];
  if (head)
    head.refs = [
      { name: 'main', kind: 'head' },
      { name: 'origin/main', kind: 'remote' },
    ];
  const release = commits.find((c) => c.subject.startsWith('Release'));
  if (release) release.refs = [{ name: 'v2.3.0', kind: 'tag' }];
  const feature = commits[3];
  if (name === 'app' && feature) feature.refs = [{ name: 'feat/checkout-vat', kind: 'branch' }];
  return commits;
}

// ---------------------------------------------------------------------------------------------
// The demo projects
// ---------------------------------------------------------------------------------------------

export interface DemoProjects {
  list: Project[];
  byId: Map<string, Project>;
}

const PROJECT_IDS: Record<string, string> = {
  app: 'prj_demoapp00001',
  web: 'prj_demoweb00001',
  api: 'prj_demoapi00001',
};

/** One project per repository of the demo runs (plus their files and history). */
export function createDemoProjects(runs: readonly Run[], now: number): DemoProjects {
  const paths = [...new Set(runs.map((r) => r.repoPath))];
  const list = paths.map((path, i): Project => {
    const name = path.split('/').filter(Boolean).at(-1) ?? path;
    return {
      id: PROJECT_IDS[name] ?? `prj_demo${String(i).padStart(8, '0')}`,
      path,
      name,
      addedAt: now - (40 - i) * DAY,
      lastOpenedAt: now - (i + 1) * HOUR,
      pinned: false,
    };
  });
  for (const run of runs) {
    const project = list.find((p) => p.path === run.repoPath);
    if (project) run.projectId = project.id;
  }
  return { list, byId: new Map(list.map((p) => [p.id, p])) };
}

function filesOf(project: Project): Record<string, string> {
  return REPOS[project.name] ?? smallRepo(project.name, 'A repository added in demo mode.', {});
}

function clean(path: string): string {
  const parts = path.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || p.toLowerCase() === '.git') || path.startsWith('/'))
    throw new RpcError('bad_request', 'path leaves the project');
  return parts.join('/');
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function demoListDir(project: Project, dir: string): FileList {
  const base = clean(dir);
  const prefix = base ? `${base}/` : '';
  const files = Object.keys(filesOf(project)).filter((p) => p.startsWith(prefix));
  if (base && files.length === 0) throw new RpcError('not_found', `${base} is not a directory of the project`);
  const dirs = new Set<string>();
  const entries: FileEntry[] = [];
  for (const path of files) {
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) dirs.add(rest.slice(0, slash));
    else {
      const content = filesOf(project)[path] ?? '';
      const size = IMAGE_FILES[path] ? Math.round((IMAGE_FILES[path]?.length ?? 0) * 0.75) : bytes(content);
      entries.push({ name: rest, path, type: 'file', size });
    }
  }
  const dirEntries: FileEntry[] = [...dirs].map((name) => ({ name, path: prefix + name, type: 'dir', size: null }));
  return {
    dir: base,
    entries: [...dirEntries, ...entries].sort(
      (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || collator.compare(a.name, b.name),
    ),
  };
}

export function demoReadFile(project: Project, path: string): FileContent {
  const rel = clean(path);
  const files = filesOf(project);
  if (!(rel in files)) throw new RpcError('not_found', `${rel} is not one of the project's files`);
  const mime = imageMimeOf(rel);
  if (mime) {
    const base64 = IMAGE_FILES[rel] ?? btoa(files[rel] ?? '');
    return {
      path: rel,
      size: Math.round(base64.length * 0.75),
      kind: 'image',
      text: null,
      encoding: null,
      truncated: false,
      image: { mime, base64 },
    };
  }
  const text = files[rel] ?? '';
  return {
    path: rel,
    size: bytes(text),
    kind: 'text',
    text,
    encoding: 'utf-8',
    truncated: false,
    image: null,
    version: demoVersion(project, rel),
  };
}

/** Demo files are edited in memory (for this session); each save bumps the file's version. */
const versions = new Map<string, number>();
function demoVersion(project: Project, rel: string): string {
  return `demo:${versions.get(`${project.name}:${rel}`) ?? 0}`;
}

export function demoStatFile(project: Project, path: string) {
  const rel = clean(path);
  const text = filesOf(project)[rel];
  return { path: rel, version: text === undefined ? null : demoVersion(project, rel), size: bytes(text ?? '') };
}

export function demoWriteFile(project: Project, path: string, text: string, expectedVersion: string) {
  const rel = clean(path);
  const files = filesOf(project);
  if (!(rel in files)) throw new RpcError('not_found', `${rel} is not one of the project's files`);
  if (demoVersion(project, rel) !== expectedVersion)
    throw new RpcError('conflict', `${rel} changed on disk since it was opened`);
  files[rel] = text;
  const key = `${project.name}:${rel}`;
  versions.set(key, (versions.get(key) ?? 0) + 1);
  return demoStatFile(project, rel);
}

export function demoFind(project: Project, query: string, limit: number) {
  const paths = Object.keys(filesOf(project)).sort();
  if (!query.trim()) {
    return paths
      .sort((a, b) => a.split('/').length - b.split('/').length || collator.compare(a, b))
      .slice(0, limit)
      .map((path) => ({ path, score: 0, positions: [] }));
  }
  return fuzzyRank(query, paths, limit);
}

export function demoSearch(
  project: Project,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
  limit: number,
): SearchResult {
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
  } catch (error) {
    throw new RpcError('bad_request', error instanceof Error ? error.message : 'invalid pattern');
  }
  const matches: SearchResult['matches'] = [];
  let total = 0;
  for (const [path, text] of Object.entries(filesOf(project)).sort(([a], [b]) => a.localeCompare(b))) {
    if (imageMimeOf(path) && !path.endsWith('.svg')) continue;
    text.split('\n').forEach((line, i) => {
      const hit = pattern.exec(line);
      if (!hit) return;
      total++;
      if (matches.length < limit) matches.push({ path, line: i + 1, column: hit.index + 1, text: line, clipStart: 0 });
    });
  }
  return { matches, truncated: total > limit, fileCount: new Set(matches.map((m) => m.path)).size };
}

export function demoLog(project: Project, now: number, limit: number): Commit[] {
  return historyOf(project.name, now).slice(0, limit);
}

/** A believable diff for a demo commit: lines of one or two real files of the project, as if just added. */
export function demoShow(project: Project, now: number, sha: string): CommitDiff {
  const history = historyOf(project.name, now);
  const commit = history.find((c) => c.sha.startsWith(sha));
  if (!commit) throw new RpcError('not_found', `no commit ${sha}`);
  const files = Object.entries(filesOf(project)).filter(([path]) => !imageMimeOf(path) && languageOfPath(path));
  const picks = [files[hash(commit.sha) % files.length], files[hash(`${commit.sha}:2`) % files.length]].filter(
    (f, i, all): f is [string, string] => !!f && all.findIndex((g) => g?.[0] === f[0]) === i,
  );
  const diffFiles: DiffFile[] = picks
    .slice(0, commit.subject.startsWith('Initial') ? 2 : 1 + (hash(sha) % 2))
    .map(([path, text]) => {
      const lines = text.split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '');
      const start = Math.min(lines.length - 1, 2 + (hash(path + sha) % Math.max(1, lines.length - 6)));
      const added = lines.slice(start, Math.min(lines.length, start + 4));
      const before = lines.slice(Math.max(0, start - 3), start);
      const after = lines.slice(start + added.length, start + added.length + 3);
      const removed = added.length > 1 ? [`${added[0]?.replace(/\S.*$/, '')}// previous version`] : [];
      const oldStart = Math.max(1, start - before.length + 1);
      const body = [
        ...before.map((l) => ` ${l}`),
        ...removed.map((l) => `-${l}`),
        ...added.map((l) => `+${l}`),
        ...after.map((l) => ` ${l}`),
      ];
      const hunkText = `@@ -${oldStart},${before.length + removed.length + after.length} +${oldStart},${before.length + added.length + after.length} @@\n${body.join('\n')}`;
      return {
        path,
        oldPath: null,
        status: 'modified',
        binary: false,
        additions: added.length,
        deletions: removed.length,
        hunks: parseHunks(hunkText),
        truncated: false,
      };
    });
  return {
    from: commit.parents[0] ?? '',
    to: commit.sha,
    files: diffFiles,
    commit: {
      ...commit,
      body: commit.author === 'legion' ? 'Squash-merged by Legion after a cross-engine review.' : '',
    },
  };
}

export function demoInfo(project: Project, now: number): ProjectInfo {
  const files = filesOf(project);
  const paths = Object.keys(files);
  const stats = new Map<string, { name: string; files: number; bytes: number }>();
  let totalBytes = 0;
  for (const path of paths) {
    const size = bytes(files[path] ?? '') * 37; // the demo repo stands in for a larger one
    totalBytes += size;
    const name = languageOfPath(path);
    if (!name) continue;
    const stat = stats.get(name) ?? { name, files: 0, bytes: 0 };
    stat.files++;
    stat.bytes += size;
    stats.set(name, stat);
  }
  const history = historyOf(project.name, now);
  return {
    project,
    exists: true,
    currentBranch: 'main',
    headSha: history[0]?.sha ?? null,
    defaultBranch: 'main',
    remotes: [{ name: 'origin', url: `git@github.com:erudiet/${project.name}.git` }],
    github: { owner: 'erudiet', name: project.name },
    dirty: project.name === 'app',
    hasGh: true,
    ghAuthenticated: true,
    readme: 'README.md',
    fileCount: paths.length * 41,
    totalBytes,
    languages: [...stats.values()].sort((a, b) => b.bytes - a.bytes),
    lastCommit: history[0] ?? null,
    commitCount: project.name === 'app' ? 1532 : 214,
  };
}

export function demoStatus(project: Project): ProjectStatus {
  return {
    projectId: project.id,
    exists: true,
    branch: 'main',
    dirty: project.name === 'app',
    ahead: project.name === 'app' ? 2 : 0,
    behind: 0,
  };
}

export function demoPrs(project: Project, now: number): PrList {
  if (project.name !== 'app') return { available: true, reason: null, prs: [] };
  return {
    available: true,
    reason: null,
    prs: [
      {
        number: 412,
        title: 'Add passkey (WebAuthn) login',
        state: 'open',
        isDraft: true,
        branch: 'legion/authv2de/integration',
        author: 'bas',
        url: 'https://github.com/erudiet/app/pull/412',
        updatedAt: now - 2 * MIN,
      },
      {
        number: 409,
        title: 'Checkout: show VAT per line',
        state: 'open',
        isDraft: false,
        branch: 'feat/checkout-vat',
        author: 'mira',
        url: 'https://github.com/erudiet/app/pull/409',
        updatedAt: now - 5 * HOUR,
      },
    ],
  };
}
