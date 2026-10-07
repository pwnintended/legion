/** Demo diff data (renderer only): unified-diff snippets parsed into `DiffResult`s for `diff.get`. */
import type { DiffFile, DiffHunk, DiffLine, DiffResult } from '@shared/rpc';

interface FileSpec {
  path: string;
  status: DiffFile['status'];
  oldPath?: string;
  /** Hunks in unified format: `@@ -a,b +c,d @@ header` followed by ` `, `+`, `-` lines. */
  text: string;
}

export function parseHunks(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.replace(/^\n/, '').split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw);
    if (head) {
      hunk = {
        oldStart: Number(head[1]),
        oldLines: head[2] === undefined ? 1 : Number(head[2]),
        newStart: Number(head[3]),
        newLines: head[4] === undefined ? 1 : Number(head[4]),
        header: head[5] ?? '',
        lines: [],
      };
      hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const sign = raw[0];
    const body = raw.slice(1);
    let line: DiffLine;
    if (sign === '+') line = { kind: 'add', oldLine: null, newLine: newLine++, text: body };
    else if (sign === '-') line = { kind: 'del', oldLine: oldLine++, newLine: null, text: body };
    else if (sign === '\\') line = { kind: 'no_newline', oldLine: null, newLine: null, text: body };
    else line = { kind: 'context', oldLine: oldLine++, newLine: newLine++, text: body };
    hunk.lines.push(line);
  }
  return hunks;
}

function file(spec: FileSpec): DiffFile {
  const hunks = parseHunks(spec.text);
  const lines = hunks.flatMap((h) => h.lines);
  return {
    path: spec.path,
    oldPath: spec.oldPath ?? null,
    status: spec.status,
    binary: false,
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length,
    hunks,
    truncated: false,
  };
}

/** A whole new file as one hunk. */
function added(path: string, body: string): DiffFile {
  const lines = body.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  return file({
    path,
    status: 'added',
    text: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Run A, T4: credential table migration
// ---------------------------------------------------------------------------------------------

const MIGRATION = `
-- 0042_passkeys: WebAuthn credentials per user
CREATE TABLE passkey_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BYTEA NOT NULL,
  public_key    BYTEA NOT NULL,
  -- COSE algorithm identifier (-7 = ES256, -257 = RS256)
  algorithm     INTEGER NOT NULL,
  aaguid        UUID,
  device_type   TEXT NOT NULL CHECK (device_type IN ('single_device', 'multi_device')),
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  nickname      TEXT,
  -- Authenticators may report counters above 2^31: keep the full 64-bit range.
  sign_count    BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX passkey_credentials_credential_id_idx
  ON passkey_credentials (credential_id);

-- down
DROP INDEX IF EXISTS passkey_credentials_credential_id_idx;
DROP TABLE IF EXISTS passkey_credentials;
`;

const SCHEMA = `
@@ -1,6 +1,8 @@
 import {
+  bigint,
   boolean,
+  bytea,
   integer,
   pgTable,
   text,
   timestamp,
@@ -82,4 +84,21 @@ export const sessions = pgTable('sessions', {
   expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
 });

-export type Session = typeof sessions.$inferSelect;
+export type Session = typeof sessions.$inferSelect;
+
+/** WebAuthn credentials (migration 0042). credential_id is raw bytes; the API encodes it as base64url. */
+export const passkeyCredentials = pgTable('passkey_credentials', {
+  id: uuid('id').primaryKey().defaultRandom(),
+  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
+  credentialId: bytea('credential_id').notNull(),
+  publicKey: bytea('public_key').notNull(),
+  algorithm: integer('algorithm').notNull(),
+  aaguid: uuid('aaguid'),
+  deviceType: text('device_type').$type<'single_device' | 'multi_device'>().notNull(),
+  backedUp: boolean('backed_up').notNull().default(false),
+  nickname: text('nickname'),
+  signCount: bigint('sign_count', { mode: 'bigint' }).notNull().default(0n),
+  transports: text('transports').array().notNull().default([]),
+  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
+});
`;

const REPO = `
import { and, eq, sql } from 'drizzle-orm';
import { passkeyCredentials } from '../../db/schema';
import { db } from './client';

export type PasskeyCredential = typeof passkeyCredentials.$inferSelect;
export type NewPasskeyCredential = typeof passkeyCredentials.$inferInsert;

export async function createCredential(input: NewPasskeyCredential): Promise<PasskeyCredential> {
  const [row] = await db.insert(passkeyCredentials).values(input).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function findByCredentialId(credentialId: Uint8Array): Promise<PasskeyCredential | null> {
  const [row] = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.credentialId, Buffer.from(credentialId)))
    .limit(1);
  return row ?? null;
}

export async function listForUser(userId: string): Promise<PasskeyCredential[]> {
  return db.select().from(passkeyCredentials).where(eq(passkeyCredentials.userId, userId));
}

/**
 * Store the authenticator's new signature counter. A counter that does not grow means a cloned
 * authenticator (unless both are 0, which synced passkeys report), so the caller rejects the assertion.
 */
export async function bumpCounter(id: string, next: bigint): Promise<boolean> {
  const result = await db
    .update(passkeyCredentials)
    .set({ signCount: next, lastUsedAt: sql\`now()\` })
    .where(and(eq(passkeyCredentials.id, id), sql\`\${passkeyCredentials.signCount} < \${next}\`));
  return result.rowCount === 1;
}
`;

const REPO_TEST = `
@@ -1,9 +1,13 @@
 import { describe, expect, it } from 'vitest';
-import { createCredential, findByCredentialId } from './passkeys.repo';
+import { bumpCounter, createCredential, findByCredentialId } from './passkeys.repo';
 import { withTestDb } from './test-db';

 describe('passkeys repository', () => {
   it('finds a credential by its raw id', async () => {
     await withTestDb(async () => {
-      const created = await createCredential(fixture());
+      const created = await createCredential(fixture({ signCount: 0n }));
       expect(await findByCredentialId(created.credentialId)).toEqual(created);
     });
   });
+
+  it('keeps sign counters above 2^31', async () => {
+    await withTestDb(async () => {
+      const created = await createCredential(fixture());
+      expect(await bumpCounter(created.id, 2n ** 32n + 1n)).toBe(true);
+      expect((await findByCredentialId(created.credentialId))?.signCount).toBe(2n ** 32n + 1n);
+    });
+  });
 });
`;

// ---------------------------------------------------------------------------------------------
// Run B: invoice PDF export (base...integration)
// ---------------------------------------------------------------------------------------------

const VIEW_MODEL = `
import type { Invoice, LineItem } from '../db/types';
import { formatMoney } from '../money';

export interface InvoiceView {
  number: string;
  issuedOn: string;
  customer: { name: string; address: string[] };
  lines: { description: string; quantity: number; unit: string; total: string }[];
  subtotal: string;
  tax: string;
  total: string;
}

/** Shape an invoice for rendering: money is formatted once, here, in the invoice's currency. */
export function toInvoiceView(invoice: Invoice, items: readonly LineItem[]): InvoiceView {
  const money = (cents: number) => formatMoney(cents, invoice.currency);
  return {
    number: invoice.number,
    issuedOn: invoice.issuedAt.toISOString().slice(0, 10),
    customer: { name: invoice.customerName, address: invoice.customerAddress.split('\\n') },
    lines: items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: money(item.unitCents),
      total: money(item.unitCents * item.quantity),
    })),
    subtotal: money(invoice.subtotalCents),
    tax: money(invoice.taxCents),
    total: money(invoice.totalCents),
  };
}
`;

const RENDER = `
import PDFDocument from 'pdfkit';
import type { InvoiceView } from '../view-model';

const FONT = new URL('../../../assets/fonts/Inter-Regular.ttf', import.meta.url).pathname;

export async function renderInvoicePdf(view: InvoiceView): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.registerFont('body', FONT);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.font('body').fontSize(20).text(\`Invoice \${view.number}\`);
  doc.fontSize(10).fillColor('#555').text(view.issuedOn).moveDown();
  doc.fillColor('#000').text(view.customer.name);
  for (const line of view.customer.address) doc.text(line);
  doc.moveDown();
  for (const line of view.lines) {
    doc.text(\`\${line.quantity} × \${line.description}\`, { continued: true }).text(line.total, { align: 'right' });
  }
  doc.moveDown().text(\`Total \${view.total}\`, { align: 'right' });
  doc.end();
  return done;
}
`;

const ROUTES = `
@@ -1,6 +1,8 @@
 import { Router } from 'express';
 import { requireUser } from '../auth/middleware';
+import { renderInvoicePdf } from '../../invoices/pdf/render';
+import { toInvoiceView } from '../../invoices/view-model';
 import { invoices } from '../db/invoices';

 export const invoiceRoutes = Router();
@@ -21,3 +23,17 @@ invoiceRoutes.get('/invoices/:id', requireUser, async (req, res) => {
   if (!invoice) return res.status(404).json({ error: 'NOT_FOUND' });
   res.json(invoice);
 });
+
+invoiceRoutes.get('/invoices/:id.pdf', requireUser, async (req, res) => {
+  const invoice = await invoices.findForUser(req.params.id, req.user.id);
+  if (!invoice) return res.status(404).json({ error: 'NOT_FOUND' });
+  const items = await invoices.lineItems(invoice.id);
+  const pdf = await renderInvoicePdf(toInvoiceView(invoice, items));
+  res
+    .type('application/pdf')
+    .set('Content-Disposition', \`attachment; filename="invoice-\${invoice.number}.pdf"\`)
+    .set('Cache-Control', 'private, no-store')
+    .send(pdf);
+});
`;

const BUTTON = `
import { useState } from 'react';
import { Button } from '../ui/Button';
import { DownloadIcon } from '../ui/icons';

export function ExportButton({ invoiceId, number }: { invoiceId: string; number: string }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(\`/api/invoices/\${invoiceId}.pdf\`);
      if (!res.ok) throw new Error(\`export failed: \${res.status}\`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: \`invoice-\${number}.pdf\` });
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" onClick={download} disabled={busy}>
      <DownloadIcon /> {busy ? 'Exporting…' : 'Export PDF'}
    </Button>
  );
}
`;

const PAGE = `
@@ -3,6 +3,7 @@ import { useInvoice } from './useInvoice';
 import { InvoiceLines } from './InvoiceLines';
 import { PageHeader } from '../ui/PageHeader';
+import { ExportButton } from './ExportButton';

 export function InvoicePage({ id }: { id: string }) {
   const invoice = useInvoice(id);
@@ -12,7 +13,10 @@ export function InvoicePage({ id }: { id: string }) {
   return (
     <>
-      <PageHeader title={\`Invoice \${invoice.number}\`} />
+      <PageHeader
+        title={\`Invoice \${invoice.number}\`}
+        actions={<ExportButton invoiceId={invoice.id} number={invoice.number} />}
+      />
       <InvoiceLines lines={invoice.lines} />
     </>
   );
`;

const SNAPSHOT_TEST = `
import { describe, expect, it } from 'vitest';
import { renderInvoicePdf } from '../../src/invoices/pdf/render';
import { toInvoiceView } from '../../src/invoices/view-model';
import { invoiceFixture, itemsFixture } from './fixtures';

describe('invoice PDF', () => {
  it('matches the golden file', async () => {
    const pdf = await renderInvoicePdf(toInvoiceView(invoiceFixture, itemsFixture));
    await expect(normalize(pdf)).toMatchFileSnapshot('./__golden__/invoice-1042.pdf.txt');
  });
});

/** Strip creation dates and ids so the snapshot is stable. */
function normalize(pdf: Buffer): string {
  return pdf
    .toString('latin1')
    .replace(/\\/CreationDate \\(D:[^)]*\\)/g, '')
    .replace(/\\/ID \\[<[0-9a-f]+> <[0-9a-f]+>\\]/g, '');
}
`;

function lockfile(): DiffFile {
  const lines: string[] = [];
  const pkgs = ['pdfkit@0.17.2', 'fontkit@2.0.4', 'linebreak@1.1.0', 'png-js@1.0.0', 'restructure@3.0.2'];
  for (const pkg of pkgs) {
    lines.push(`+  /${pkg}:`, '+    resolution: {integrity: sha512-…}', '+    dev: false', '+');
    for (let i = 0; i < 90; i++) lines.push(`+    dependency-${i}: 1.${i}.0`);
  }
  return file({
    path: 'pnpm-lock.yaml',
    status: 'modified',
    text: `@@ -2210,3 +2210,${lines.length + 3} @@\n   /pathe@1.1.2:\n     resolution: {integrity: sha512-…}\n     dev: true\n${lines.join('\n')}`,
  });
}

export function demoDiffs(ids: { t4: string; runB: string; runA: string }): Record<string, DiffResult> {
  return {
    [`task:${ids.t4}`]: {
      from: 'a1f3c9e',
      to: '5d2e0b7',
      files: [
        added('migrations/0042_passkeys.sql', MIGRATION),
        file({ path: 'db/schema.ts', status: 'modified', text: SCHEMA }),
        added('server/db/passkeys.repo.ts', REPO),
        file({ path: 'server/db/passkeys.repo.test.ts', status: 'modified', text: REPO_TEST }),
      ],
    },
    [`run:${ids.runB}`]: {
      from: 'main',
      to: 'legion/pdfexpor/integration',
      files: [
        added('src/invoices/view-model.ts', VIEW_MODEL),
        added('src/invoices/pdf/render.ts', RENDER),
        file({ path: 'src/server/routes/invoices.ts', status: 'modified', text: ROUTES }),
        added('web/src/invoices/ExportButton.tsx', BUTTON),
        file({ path: 'web/src/invoices/InvoicePage.tsx', status: 'modified', text: PAGE }),
        added('tests/invoices/pdf.snapshot.test.ts', SNAPSHOT_TEST),
        lockfile(),
      ],
    },
    [`run:${ids.runA}`]: {
      from: 'main',
      to: 'legion/authv2de/integration',
      files: [
        file({
          path: 'auth/contracts.ts',
          status: 'added',
          text: '@@ -0,0 +1,3 @@\n+export interface PasskeyCredentialDto {\n+  id: string;\n+}',
        }),
      ],
    },
  };
}
