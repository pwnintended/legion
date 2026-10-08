import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveGateSettings } from './gates';
import {
  countAddedLines,
  diffAddedLines,
  maskSecret,
  SECRET_RULES,
  scanSecrets,
  secretsGateResult,
  shannonEntropy,
} from './secrets';

// Every fake token is built at runtime (prefix + pseudo-random tail), so this file holds no scannable secret.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function random(length: number, seed: number, alphabet = ALNUM): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor((state / 2147483648) * alphabet.length)];
  }
  return out;
}
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const TOKENS = {
  aws: ['AK', 'IA', random(16, 1, UPPER_DIGITS)].join(''),
  ghp: ['gh', 'p_', random(36, 2)].join(''),
  githubPat: ['github', '_pat_', random(22, 3), '_', random(59, 4)].join(''),
  slack: ['xo', 'xb-', random(12, 5, '0123456789'), '-', random(24, 6)].join(''),
  stripe: ['sk', '_live_', random(24, 7)].join(''),
  google: ['AI', 'za', random(35, 8)].join(''),
  openai: ['sk', '-proj-', random(48, 9)].join(''),
  anthropic: ['sk', '-ant-api03-', random(80, 10)].join(''),
  generic: random(32, 11),
  letters: random(27, 13, ALNUM.slice(0, 52)),
};
const PUNCT = '!#%&*+:;?@^~';
/** Passwords with the other quote character, punctuation, or an escaped delimiter inside. */
const PASSWORDS = {
  apostrophe: [random(9, 40), "'", random(3, 41, PUNCT), random(8, 42), "'", random(6, 43)].join(''),
  doubleQuote: [random(10, 44), '"', random(4, 45, PUNCT), random(10, 46)].join(''),
  escaped: [random(10, 47), '\\"', random(3, 48, PUNCT), random(10, 49)].join(''),
  spaced: [random(8, 50), ' ', random(3, 51, PUNCT), random(11, 52)].join(''),
};
const PEM_HEADER = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('');
const PEM_BODY = random(64, 12);

/** A new file with these lines. */
function newFile(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const rulesOf = (diff: string, allow: readonly string[] = []) => scanSecrets(diff, { allow }).map((f) => f.rule);

describe('diffAddedLines', () => {
  it('reports added lines with new-file line numbers, never removed or context lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@ function f() {',
      ' context ten',
      '-removed old',
      '+added eleven',
      ' context twelve',
      '+added thirteen',
      ' context fourteen',
      '@@ -40 +41,2 @@',
      '-old forty',
      '+++ added forty-one, starts with pluses',
      '+--- added forty-two, starts with dashes',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(diffAddedLines(diff)).toEqual([
      { file: 'src/a.ts', line: 11, text: 'added eleven' },
      { file: 'src/a.ts', line: 13, text: 'added thirteen' },
      { file: 'src/a.ts', line: 41, text: '++ added forty-one, starts with pluses' },
      { file: 'src/a.ts', line: 42, text: '--- added forty-two, starts with dashes' },
    ]);
    expect(countAddedLines(diff)).toBe(4);
  });

  it('handles deletions, renames, binary files, quoted paths and CRLF', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -3,1 +3,2 @@',
      ' kept',
      '+renamed add',
      'diff --git a/pure.ts b/moved.ts',
      'similarity index 100%',
      'rename from pure.ts',
      'rename to moved.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git "a/dir/caf\\303\\251 x.ts" "b/dir/caf\\303\\251 x.ts"',
      '--- "a/dir/caf\\303\\251 x.ts"',
      '+++ "b/dir/caf\\303\\251 x.ts"',
      '@@ -0,0 +1 @@',
      '+quoted add\r',
      '',
    ].join('\n');
    expect(diffAddedLines(diff)).toEqual([
      { file: 'new/name.ts', line: 4, text: 'renamed add' },
      { file: 'dir/café x.ts', line: 1, text: 'quoted add' },
    ]);
  });
});

describe('scanSecrets: true positives', () => {
  it.each([
    ['private-key', `${PEM_HEADER}`],
    ['private-key', `"private_key": "${PEM_HEADER}\\n${PEM_BODY}\\n"`],
    ['aws-access-key-id', `aws_access_key_id = ${TOKENS.aws}`],
    ['github-token', `const t = '${TOKENS.ghp}';`],
    ['github-fine-grained-token', `GH=${TOKENS.githubPat}`],
    ['slack-token', `slack: "${TOKENS.slack}"`],
    ['stripe-live-key', `Stripe('${TOKENS.stripe}')`],
    ['google-api-key', `const maps = "${TOKENS.google}";`],
    ['openai-api-key', `OPENAI=${TOKENS.openai}`],
    ['anthropic-api-key', `new Anthropic({ apiKey: '${TOKENS.anthropic}' })`],
    ['generic-secret', `const apiKey = "${TOKENS.generic}";`],
    ['generic-secret', `DB_PASSWORD=${TOKENS.generic}`],
    ['generic-secret', `  "client_secret": "${TOKENS.generic}",`],
    ['generic-secret', `  token: \`${TOKENS.generic}\``],
    ['generic-secret', `api_key: ${TOKENS.generic}`],
    ['generic-secret', `password = "${TOKENS.letters}"`],
    ['generic-secret', `DB_PASSWORD=${TOKENS.generic} # production database`],
    ['generic-secret', `export API_TOKEN=${TOKENS.generic}   # rotated monthly`],
    ['generic-secret', `  password: ${TOKENS.letters}  # prod`],
    ['generic-secret', `client_secret = ${TOKENS.generic} ; ini comment`],
    ['generic-secret', `const password = "${PASSWORDS.apostrophe}";`],
    ['generic-secret', `db_password: '${PASSWORDS.doubleQuote}'`],
    ['generic-secret', `secret = "${PASSWORDS.escaped}"`],
    ['generic-secret', `const token = \`${PASSWORDS.apostrophe}\`;`],
    ['generic-secret', `const password = "${PASSWORDS.spaced}";`],
    ['generic-secret', `db_secret: '${PASSWORDS.spaced}'`],
    ['private-key', `key = "${PEM_HEADER}\\n${PEM_BODY}"; // example`],
    ['private-key', `key = "${PEM_HEADER}\\n${PEM_BODY}" # dummy value, changeme`],
  ])('detects %s in %j', (rule, line) => {
    expect(rulesOf(newFile('src/config.ts', [line]))).toEqual([rule]);
  });

  it('reports file, new-file line and the specific rule rather than the generic one', () => {
    const findings = scanSecrets(
      newFile('src/a.ts', ['// nothing here', `const GITHUB_TOKEN = '${TOKENS.ghp}';`, `AWS=${TOKENS.aws}`]),
    );
    expect(findings.map(({ file, line, rule }) => ({ file, line, rule }))).toEqual([
      { file: 'src/a.ts', line: 2, rule: 'github-token' },
      { file: 'src/a.ts', line: 3, rule: 'aws-access-key-id' },
    ]);
  });

  it('reports a generic secret next to a provider token on the same line, masking both', () => {
    const findings = scanSecrets(
      newFile('src/a.ts', [`connect({ token: '${TOKENS.ghp}', password: "${TOKENS.letters}" });`]),
    );
    expect(findings.map((f) => f.rule)).toEqual(['github-token', 'generic-secret']);
    for (const f of findings) {
      expect(f.excerpt).toBe(
        `connect({ token: '${TOKENS.ghp.slice(0, 4)}…', password: "${TOKENS.letters.slice(0, 4)}…" });`,
      );
    }
  });

  it('reports a bare assignment and a provider token in its inline comment, masking both', () => {
    for (const line of [
      `DB_PASSWORD=${TOKENS.generic} # ${TOKENS.ghp}`,
      `db_password: ${TOKENS.generic}  # old: ${TOKENS.ghp}`,
    ]) {
      const findings = scanSecrets(newFile('.env', [line]));
      expect(findings.map((f) => f.rule)).toEqual(['github-token', 'generic-secret']);
      const result = secretsGateResult(findings, resolveGateSettings({}), 1, 1);
      for (const text of [result.outputTail, result.summary, ...findings.map((f) => f.excerpt)]) {
        expect(text).not.toContain(TOKENS.generic.slice(0, 8));
        expect(text).not.toContain(TOKENS.ghp.slice(0, 8));
      }
      expect(findings[0]?.excerpt).toContain(`${TOKENS.generic.slice(0, 4)}…`);
      expect(findings[0]?.excerpt).toContain(`${TOKENS.ghp.slice(0, 4)}…`);
    }
  });

  it('reports a private key header whatever text follows it, masking the inline body', () => {
    for (const comment of ['// example', '# dummy', '/* placeholder: changeme <token> */']) {
      const [finding, ...rest] = scanSecrets(newFile('src/k.ts', [`key = "${PEM_HEADER}\\n${PEM_BODY}"; ${comment}`]));
      expect(rest).toEqual([]);
      expect(finding?.rule).toBe('private-key');
      expect(finding?.excerpt.startsWith(`key = "${PEM_HEADER}\\n${PEM_BODY.slice(0, 2)}…`)).toBe(true);
      expect(finding?.excerpt).not.toContain(PEM_BODY.slice(0, 8));
    }
  });

  it('reports and masks a password with quotes inside beside a provider token', () => {
    for (const [quote, password] of [
      ['"', PASSWORDS.apostrophe],
      ["'", PASSWORDS.doubleQuote],
      ['"', PASSWORDS.escaped],
      ['"', PASSWORDS.spaced],
      ["'", PASSWORDS.spaced],
    ] as const) {
      const line = `connect('${TOKENS.ghp}', { password: ${quote}${password}${quote} });`;
      const findings = scanSecrets(newFile('src/db.ts', [line]));
      expect(findings.map((f) => f.rule)).toEqual(['github-token', 'generic-secret']);
      expect(findings[0]?.excerpt).toBe(
        `connect('${TOKENS.ghp.slice(0, 4)}…', { password: ${quote}${password.slice(0, 4)}…${quote} });`,
      );
      const result = secretsGateResult(findings, resolveGateSettings({}), 1, 1);
      for (const text of [result.outputTail, result.summary, ...findings.map((f) => f.excerpt)]) {
        expect(text).not.toContain(password);
        expect(text).not.toContain(password.slice(0, 8));
      }
    }
  });

  it('masks a random-looking quoted literal no rule claimed when the line has a finding', () => {
    const [finding] = scanSecrets(newFile('src/a.ts', [`const t = '${TOKENS.ghp}'; sign("${PASSWORDS.apostrophe}");`]));
    expect(finding?.rule).toBe('github-token');
    expect(finding?.excerpt).toBe(
      `const t = '${TOKENS.ghp.slice(0, 4)}…'; sign("${PASSWORDS.apostrophe.slice(0, 4)}…");`,
    );
  });

  it('masks a random-looking run no rule claimed when the line has a finding', () => {
    const other = random(40, 30);
    const [finding] = scanSecrets(newFile('src/a.ts', [`const t = '${TOKENS.ghp}'; sign(${other});`]));
    expect(finding?.excerpt).toBe(`const t = '${TOKENS.ghp.slice(0, 4)}…'; sign(${other.slice(0, 4)}…);`);
  });

  it('keeps the rules a readable table of unique ids', () => {
    const ids = SECRET_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('generic-secret');
    for (const rule of SECRET_RULES) {
      expect(rule.description).not.toBe('');
      expect(rule.pattern.flags).toContain('g');
    }
  });
});

describe('scanSecrets: false positives', () => {
  it.each([
    'password = "changeme"',
    'const API_KEY = "change_me_please_1234";',
    `token = "${'x'.repeat(40)}"`,
    `const gh = 'gh${'p_'}${'x'.repeat(36)}';`,
    'apiKey: "<token>"',
    'secret: "<your-api-key-here-1234>"',
    `password: "\${DB_PASSWORD}"`,
    'token: "{{ secrets.DEPLOY_TOKEN_2024 }}"',
    'const token = process.env.GITHUB_TOKEN;',
    'apiKey: process.env.OPENAI_API_KEY_PRODUCTION1',
    'API_KEY=$API_KEY_FROM_THE_VAULT_2024',
    `password = "${'ab'.repeat(12)}"`,
    'secret = "aaaaaaaaaaaaaaaaaaaaaaaa1"',
    'const token = "correct-horse-battery-staple";',
    'const password = "ThisIsMyDevelopmentPassword";',
    'SIGNING_SECRET=DEPLOYMENT_SIGNING_SECRET',
    'token_type: "Bearer"',
    'const tokenError = "Token expired at 2024, please refresh";',
    "password_hint: 'Use 12+ chars, 1 digit and 1 symbol'",
    'password: string;',
    'if (password == "abc123def456ghi789jkl") {',
    `integrity_token: "sha512-${random(64, 20)}"`,
    `aws_access_key_id = ${['AK', 'IA'].join('')}IOSFODNN7${'EXAMPLE'}`,
    `const id = '${random(40, 21, '0123456789abcdef')}'; // a commit hash, no secret name`,
  ])('ignores %j', (line) => {
    expect(rulesOf(newFile('src/config.ts', [line]))).toEqual([]);
  });

  it('skips lines marked legion:allow-secret', () => {
    expect(rulesOf(newFile('src/a.ts', [`const t = '${TOKENS.ghp}'; // legion:allow-secret`]))).toEqual([]);
  });

  it('skips files matching an allow glob, and lockfiles', () => {
    const line = `token: "${TOKENS.generic}" ${TOKENS.ghp}`;
    const diff = [
      newFile('fixtures/tokens.json', [line]),
      newFile('test/data/keys.txt', [line]),
      newFile('pnpm-lock.yaml', [line]),
      newFile('packages/web/package-lock.json', [line]),
      newFile('Cargo.lock', [line]),
      newFile('src/real.ts', [line]),
    ].join('');
    const files = scanSecrets(diff, { allow: ['fixtures/**', 'test/data'] }).map((f) => f.file);
    expect([...new Set(files)]).toEqual(['src/real.ts']);
  });

  it('never reports removed or context lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ` const kept = '${TOKENS.ghp}';`,
      `-const removed = '${TOKENS.stripe}';`,
      '+const replaced = process.env.STRIPE_KEY;',
      '',
    ].join('\n');
    expect(scanSecrets(diff)).toEqual([]);
  });

  it('does not flag its own sources', () => {
    for (const name of ['secrets.ts', 'secrets.test.ts']) {
      const text = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      expect(scanSecrets(newFile(`src/engine/orchestrator/core/${name}`, text.split('\n')))).toEqual([]);
    }
  });
});

describe('masking', () => {
  it('shows at most the first 4 characters', () => {
    expect(maskSecret(TOKENS.ghp)).toBe(`${TOKENS.ghp.slice(0, 4)}…`);
    expect(maskSecret('abcdefgh')).toBe('ab…');
    expect(maskSecret('ab')).toBe('…');
  });

  it('masks every secret on the line and clips long lines', () => {
    const [finding] = scanSecrets(newFile('src/a.ts', [`const a = '${TOKENS.ghp}', b = '${TOKENS.stripe}';`]));
    expect(finding?.excerpt).toBe(`const a = '${TOKENS.ghp.slice(0, 4)}…', b = '${TOKENS.stripe.slice(0, 4)}…';`);
    const long = scanSecrets(newFile('src/a.min.js', [`${'x=1;'.repeat(100)}k='${TOKENS.ghp}';${'y=2;'.repeat(100)}`]));
    expect(long[0]?.excerpt.length).toBeLessThanOrEqual(122);
    expect(long[0]?.excerpt).toContain(`${TOKENS.ghp.slice(0, 4)}…`);
  });

  it('masks a private key body that follows the header on the same line', () => {
    const [finding] = scanSecrets(newFile('creds.json', [`"key": "${PEM_HEADER}\\n${PEM_BODY}"`]));
    expect(finding?.excerpt).toContain(PEM_HEADER);
    expect(finding?.excerpt).not.toContain(PEM_BODY.slice(0, 8));
  });

  it.each([
    ['trailing spaces', '   '],
    ['trailing tabs', '\t\t'],
    ['mixed trailing whitespace', ' \t \r'],
  ])('masks an inline private key body with %s', (_, tail) => {
    const findings = scanSecrets(newFile('creds.json', [`  "key": "${PEM_HEADER}\\n${PEM_BODY}"${tail}`]));
    expect(findings.map((f) => f.rule)).toEqual(['private-key']);
    expect(findings[0]?.excerpt).toBe(`"key": "${PEM_HEADER}\\n${PEM_BODY.slice(0, 2)}…`);
  });
});

describe('entropy', () => {
  it('scores random strings above repetitive ones', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(shannonEntropy(TOKENS.generic)).toBeGreaterThan(3.5);
    expect(shannonEntropy('ab'.repeat(16))).toBe(1);
  });
});

describe('secretsGateResult', () => {
  const block = resolveGateSettings({});
  const warn = resolveGateSettings({ gates: { secrets: 'warn' } });
  const off = resolveGateSettings({ gates: { secrets: { mode: 'off' } } });

  it('passes with the number of added lines', () => {
    expect(secretsGateResult([], block, 42, 7)).toEqual({
      command: 'legion:secrets',
      exitCode: 0,
      outputTail: '',
      durationMs: 7,
      name: 'secrets',
      kind: 'secrets',
      status: 'pass',
      blocking: true,
      summary: 'no secrets in 42 added lines',
      source: 'builtin',
    });
    expect(secretsGateResult([], block, 1, 0).summary).toBe('no secrets in 1 added line');
  });

  it('fails, blocking in block mode and warning in warn mode, listing every finding', () => {
    const diff = newFile('src/a.ts', ['ok', `const t = '${TOKENS.ghp}';`, `KEY=${TOKENS.stripe}`]);
    const findings = scanSecrets(diff);
    const result = secretsGateResult(findings, block, countAddedLines(diff), 12);
    expect(result).toMatchObject({
      status: 'fail',
      blocking: true,
      exitCode: 1,
      kind: 'secrets',
      summary: '2 possible secrets, first at src/a.ts:2',
    });
    expect(result.outputTail.split('\n')).toEqual([
      `src/a.ts:2 github-token const t = '${TOKENS.ghp.slice(0, 4)}…';`,
      `src/a.ts:3 stripe-live-key KEY=${TOKENS.stripe.slice(0, 4)}…`,
    ]);
    expect(secretsGateResult(findings, warn, 3, 12)).toMatchObject({ status: 'fail', blocking: false });
  });

  it('is skipped when the scan is off', () => {
    expect(secretsGateResult([], off, 3, 0)).toMatchObject({ status: 'skipped', blocking: false });
  });

  it('never outputs a full secret value', () => {
    const lines = [
      ...Object.values(TOKENS).map((t) => `secret_value = "${t}"`),
      `"pem": "${PEM_HEADER}\\n${PEM_BODY}"`,
      `"pem": "${PEM_HEADER}\\n${PEM_BODY}" \t `,
      `t = '${TOKENS.ghp}'; password = "${TOKENS.letters}"; api_key = '${TOKENS.generic}'`,
      `DB_PASSWORD=${TOKENS.generic} # ${TOKENS.stripe}`,
      `key = "${PEM_HEADER}\\n${PEM_BODY}"; // example`,
      `t = '${TOKENS.ghp}'; password = "${PASSWORDS.apostrophe}"`,
      `t = '${TOKENS.stripe}'; secret: '${PASSWORDS.doubleQuote}'; sign("${PASSWORDS.escaped}")`,
      `t = '${TOKENS.ghp}'; password = "${PASSWORDS.spaced}"; sign('${PASSWORDS.spaced}')`,
    ];
    const findings = scanSecrets(newFile('src/leak.ts', lines));
    expect(new Set(findings.map((f) => f.line)).size).toBe(lines.length);
    /** Rules reported on the line containing `marker`. */
    const rulesOn = (marker: string) => findings.filter((f) => lines[f.line - 1]?.includes(marker)).map((f) => f.rule);
    const both = (provider: string) => [provider, 'generic-secret'];
    expect(rulesOn(`api_key = '${TOKENS.generic}'`)).toEqual(both('github-token'));
    expect(rulesOn(`# ${TOKENS.stripe}`)).toEqual(both('stripe-live-key'));
    expect(rulesOn(PASSWORDS.apostrophe)).toEqual(both('github-token'));
    expect(rulesOn(PASSWORDS.doubleQuote)).toEqual(both('stripe-live-key'));
    expect(rulesOn(PASSWORDS.spaced)).toEqual(both('github-token'));
    const result = secretsGateResult(findings, block, lines.length, 1);
    const output = [result.summary, result.outputTail, ...findings.map((f) => f.excerpt)].join('\n');
    for (const value of [...Object.values(TOKENS), ...Object.values(PASSWORDS), PEM_BODY]) {
      expect(output).not.toContain(value);
      expect(output).not.toContain(value.slice(0, 8));
    }
  });
});
