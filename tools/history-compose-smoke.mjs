// Synthetic-only check of generated Compose: no manifest rewriting or manual chown.
// Requires round2 in the fixture volume from tools/wechat-key-import/fixture.
// node tools/history-compose-smoke.mjs [fixture-volume] [app-image]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const input = process.argv[2] || 'snsbox-key-preparation-fixtures';
const appImage = process.argv[3] || 'snsbox:0.1.0';
const repo = fileURLToPath(new URL('../', import.meta.url));
const project = `snsbox-history-check-${randomUUID().slice(0, 8)}`;
const holder = project + '-input';
const dir = await mkdtemp(join(tmpdir(), project + '-'));
const bundle = join(dir, 'bundle');
const staged = join(dir, 'staged');
const source = join(dir, 'synthetic-password');
const key = join(dir, 'password.keys.json');
const password = randomUUID();
const env = { ...process.env, SNSBOX_PORT: '0', SNSBOX_BIND_ADDRESS: '127.0.0.1' };
const run = (cmd, args) => execFileSync(cmd, args, {
  encoding: 'utf8', cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const docker = (...args) => run('docker', args);
let holderCreated = false;
let composeArgs;
let volumes = [];
try {
  docker('volume', 'inspect', input);
  docker('create', '--name', holder, '--network', 'none', '--read-only',
    '--mount', `type=volume,src=${input},dst=/fixture,readonly`,
    '--entrypoint', '/bin/true', appImage);
  holderCreated = true;
  docker('cp', holder + ':/fixture/round2/password.key', join(dir, 'marker'));
  assert.equal((await readFile(join(dir, 'marker'), 'utf8')).trim(), '41'.repeat(32));
  docker('cp', holder + ':/fixture/round2/synthetic-password', source);
  docker('cp', holder + ':/fixture/round2/password.keys.json', key);
  const keyBefore = await readFile(key);
  const modeBefore = (await stat(key)).mode;
  const prepare = run('python', ['-B', 'tools/history-snapshot/prepare.py', 'prepare', source,
    '--active-root', join(dir, 'protected-live'), '--source-kind', 'synthetic-fixture',
    '--snapshot-reference', 'synthetic-compose-check', '--captured-at', '2026-11-16T00:00:00Z',
    '--confirm-consistent-source', '--keys-file', key, '--output', bundle]);
  assert.equal(JSON.parse(prepare).readyForReader, true);
  const stage = run('python', ['-B', 'tools/history-snapshot/stage-compose.py', bundle,
    '--active-root', join(dir, 'protected-live'), '--output', staged, '--image', appImage]);
  assert.equal(JSON.parse(stage).permissionCheckPassed, true);
  const report = JSON.parse(await readFile(join(staged, 'deployment.json'), 'utf8'));
  volumes = [report.inputVolume, report.scratchVolume];
  assert.ok(volumes.every(name => /^snsbox-history-[a-f0-9]{32}-(input|scratch)$/.test(name)));
  assert.deepEqual(await readFile(key), keyBefore, 'source key bytes must remain unchanged');
  assert.equal((await stat(key)).mode, modeBefore, 'source key permissions must remain unchanged');
  const testConfig = join(dir, 'test.json');
  await writeFile(testConfig, JSON.stringify({ services: { snsbox: {
    image: appImage, restart: 'no', environment: { SNSBOX_ADMIN_PASSWORD: password },
  } } }));
  composeArgs = ['compose', '-p', project, '-f', join(repo, 'compose.yaml'),
    '-f', join(staged, 'compose.history.yaml'), '-f', testConfig];
  docker(...composeArgs, 'up', '-d', '--no-build', '--pull', 'never');
  const base = 'http://' + docker(...composeArgs, 'port', 'snsbox', '8080').split('\n')[0];
  const until = async (fn, label) => {
    for (let i = 0; i < 300; i++) {
      const result = await fn().catch(() => false);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  };
  await until(async () => (await fetch(base + '/health')).ok, 'startup');
  const login = await fetch(base + '/api/v1/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  const request = (path, options = {}) => fetch(base + path, { ...options,
    headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...options.headers } });
  const prefix = '/api/v1/history/sources/wechat-archive';
  assert.ok((await request(prefix + '/refresh', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })).ok);
  const state = await until(async () => {
    const sources = await (await request('/api/v1/history/sources')).json();
    const current = sources.items.find(item => item.id === 'wechat-archive');
    return current && !['not_loaded', 'refreshing'].includes(current.status) && current;
  }, 'history import');
  assert.equal(state.status, 'ready');
  assert.equal(state.readOnly, true);
  assert.equal(state.sendAllowed, false);
  const conversations = await (await request(prefix + '/conversations')).json();
  assert.equal(conversations.items.length, 1);
  const messages = await (await request(prefix + '/conversations/' + conversations.items[0].id + '/messages')).json();
  assert.equal(messages.items.length, 3);
  const search = await (await request(prefix + '/messages?query=Synthetic')).json();
  assert.equal(search.items.length, 3);
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, generatedCompose: true,
    manualChown: false, manifestRewrittenByTest: false, sourceKeyUnchanged: true,
    sourceState: state.status, conversations: 1, messages: 3, searchResults: 3 }));
} finally {
  if (composeArgs) {
    try { docker(...composeArgs, 'down', '--volumes', '--remove-orphans'); } catch { /* retain test error */ }
  }
  if (holderCreated) {
    try { docker('rm', '-v', holder); } catch { /* retain test error */ }
  }
  for (const volume of volumes) {
    // Only the newly generated names returned by this run's private staging report.
    if (/^snsbox-history-[a-f0-9]{32}-(input|scratch)$/.test(volume)) {
      try { docker('volume', 'rm', volume); } catch { /* retain test error */ }
    }
  }
  await rm(dir, { recursive: true, force: true });
}
