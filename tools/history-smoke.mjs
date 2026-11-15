// Synthetic-only integration: snapshot preparation + imported KeyFile + actual HTTP reader.
// Run after tools/wechat-key-import/fixture has produced and converted round2 fixtures.
// node tools/history-smoke.mjs [fixture-volume] [app-image] [python-image]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const input = process.argv[2] || 'snsbox-key-preparation-fixtures';
const appImage = process.argv[3] || 'snsbox:0.1.0';
const pythonImage = process.argv[4] || 'python:3.12-slim-bookworm';
const root = fileURLToPath(new URL('../', import.meta.url));
const name = `snsbox-history-smoke-${randomUUID().slice(0, 8)}`;
const fixtureVolume = `${name}-fixture`;
const dataVolume = `${name}-data`;
const password = randomUUID();
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let started = false;
try {
  // Require an existing fixture volume; never silently create an empty input.
  docker('volume', 'inspect', input);
  docker('volume', 'create', fixtureVolume);
  docker('volume', 'create', dataVolume);
  const preparation = docker('run', '--rm', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:mode=1777', '--mount', `type=volume,src=${input},dst=/input,readonly`,
    '--mount', `type=volume,src=${fixtureVolume},dst=/fixtures`,
    '--mount', `type=bind,src=${root},dst=/repo,readonly`, pythonImage, 'python', '-B', '-c', `
import json, os, pathlib, shutil, subprocess, sys
source = pathlib.Path('/input/round2')
# Public fixture marker only. Refuse an arbitrary profile or private key cache.
assert (source / 'password.key').read_text().strip() == '41' * 32
work = pathlib.Path('/fixtures')
os.chmod(work, 0o700)
shutil.copytree(source / 'synthetic-password', work / 'synthetic-password')
shutil.copyfile(source / 'password.keys.json', work / 'password.keys.json')
os.chmod(work / 'password.keys.json', 0o600)
subprocess.run([sys.executable, '-B', '/repo/tools/history-snapshot/prepare.py',
    'prepare', str(work / 'synthetic-password'), '--active-root', '/not-an-active-fixture',
    '--output', str(work / 'bundle'), '--source-kind', 'synthetic-fixture',
    '--snapshot-reference', 'synthetic-sqlcipher-fixture',
    '--captured-at', '2026-11-16T00:00:00Z', '--confirm-consistent-source',
    '--keys-file', str(work / 'password.keys.json')], check=True)
config = json.loads((work / 'bundle/history-sources.json').read_text())
assert config[0]['profilePath'] == '/history-snapshots/synthetic-password'
assert config[0]['confirmedConsistentSnapshot'] is True
# The test uses one private volume instead of host bind mounts. Keep account name.
config[0]['profilePath'] = '/fixtures/bundle/profiles/synthetic-password'
config[0]['keysFile'] = '/fixtures/password.keys.json'
(work / 'runtime.json').write_text(json.dumps(config))
os.chmod(work / 'runtime.json', 0o600)
for parent, dirs, files in os.walk(work):
    os.chown(parent, 10001, 10001)
    for filename in files:
        os.chown(os.path.join(parent, filename), 10001, 10001)
`);
  assert.equal(JSON.parse(preparation).readyForReader, true);
  docker('run', '-d', '--name', name, '--platform', 'linux/amd64', '--read-only',
    '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::8080', '--mount', `type=volume,src=${fixtureVolume},dst=/fixtures,readonly`,
    '--mount', `type=volume,src=${dataVolume},dst=/data`,
    '-e', 'SNSBOX_HISTORY_SOURCES_FILE=/fixtures/runtime.json',
    '-e', `SNSBOX_ADMIN_PASSWORD=${password}`, appImage);
  started = true;
  const base = `http://${docker('port', name, '8080/tcp').split('\n')[0]}`;
  async function until(fn, label) {
    for (let i = 0; i < 300; i++) {
      const value = await fn().catch(() => false);
      if (value) return value;
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  await until(async () => (await fetch(base + '/health')).ok, 'startup');
  const login = await fetch(base + '/api/v1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  const request = (path, options = {}) => fetch(base + path, {
    ...options, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...options.headers },
  });
  const prefix = '/api/v1/history/sources/wechat-archive';
  const refresh = await request(prefix + '/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.ok(refresh.ok, `refresh status ${refresh.status}`);
  const source = await until(async () => {
    const result = await (await request('/api/v1/history/sources')).json();
    const value = result.items.find(item => item.id === 'wechat-archive');
    return value && !['not_loaded', 'refreshing'].includes(value.status) && value;
  }, 'indexing');
  assert.ok(['ready', 'partial'].includes(source.status), `source state ${source.status}`);
  assert.equal(source.readOnly, true);
  assert.equal(source.sendAllowed, false);
  const conversations = await (await request(prefix + '/conversations')).json();
  assert.equal(conversations.items.length, 1);
  const messages = await (await request(prefix + '/conversations/' + conversations.items[0].id + '/messages')).json();
  assert.equal(messages.items.length, 3);
  const search = await (await request(prefix + '/messages?query=Synthetic%20key%20conversion')).json();
  assert.equal(search.items.length, 3);
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, conversations: 1,
    messages: 3, searchResults: 3, consumer: 'snsbox-http', sourceState: source.status }));
} finally {
  if (started) docker('rm', '-f', name);
  for (const volume of [fixtureVolume, dataVolume]) {
    try { docker('volume', 'rm', volume); } catch { /* Preserve original error. */ }
  }
}
