// Fake `codex app-server` for session tests: replays a recorded transcript (fixtures/*.jsonl, lines of
// {dir: 'in' | 'out', msg}). 'in' messages (server → client) are written to stdout; at each 'out'
// message it waits for the client's next message and checks it has the same shape (method for requests
// and notifications; result vs error for replies to server requests). Response ids are rewritten to the
// ids the client actually used. An 'out' entry with `expectParams` also checks those params exactly
// (synthetic transcripts only; recorded ones carry their own prompts). Exits 0 when stdin ends, 3 on a mismatch. A synthetic
// `{dir: 'exit', code}` entry makes it exit with that code (crash simulation).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const entries = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const idMap = new Map();
const incoming = [];
let waiter = null;

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const msg = JSON.parse(line);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(msg);
    } else {
      incoming.push(msg);
    }
  })
  .on('close', () => process.exit(0));

function nextClientMessage() {
  const queued = incoming.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

function fail(message) {
  process.stderr.write(`MISMATCH ${message}\n`);
  process.exit(3);
}

for (const { dir, msg, code, expectParams } of entries) {
  if (dir === 'exit') {
    // stdout is asynchronous for pipes on macOS: flush before exiting.
    await new Promise((resolve) => process.stdout.write('', resolve));
    process.exit(code);
  }
  if (dir === 'in') {
    const isResponse = msg.method === undefined && msg.id !== undefined;
    const out = isResponse ? { ...msg, id: idMap.get(msg.id) ?? msg.id } : msg;
    process.stdout.write(`${JSON.stringify(out)}\n`);
    continue;
  }
  const actual = await nextClientMessage();
  if (msg.method !== undefined) {
    if (actual.method !== msg.method) fail(`expected ${msg.method}, got ${JSON.stringify(actual).slice(0, 300)}`);
    if (msg.id !== undefined) idMap.set(msg.id, actual.id);
    for (const [key, value] of Object.entries(expectParams ?? {})) {
      if (JSON.stringify(actual.params?.[key]) !== JSON.stringify(value)) {
        fail(
          `${msg.method} params.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual.params?.[key])}`,
        );
      }
    }
  } else {
    if (actual.id !== msg.id) fail(`expected reply to ${msg.id}, got ${JSON.stringify(actual).slice(0, 300)}`);
    if ((msg.error === undefined) !== (actual.error === undefined)) {
      fail(`reply shape for ${msg.id}: expected ${JSON.stringify(msg)}, got ${JSON.stringify(actual)}`);
    }
    if (msg.result?.decision !== undefined && JSON.stringify(msg.result) !== JSON.stringify(actual.result)) {
      fail(`decision for ${msg.id}: expected ${JSON.stringify(msg.result)}, got ${JSON.stringify(actual.result)}`);
    }
  }
}
// Transcript done: stay alive until the client closes stdin.
