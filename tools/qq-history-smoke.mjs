// Synthetic-only QQ export -> Rust index -> authenticated HTTP integration.
// No NAS paths, platform login, live messages, or real credentials are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const appImage = process.argv[2] || 'snsbox:0.1.0';
const pythonImage = process.argv[3] || 'python:3.12-slim-bookworm';
const name = `snsbox-qq-history-smoke-${randomUUID().slice(0, 8)}`;
const fixture = `${name}-fixture`, data = `${name}-data`;
const password = randomUUID();
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let started = false;
try {
  docker('volume', 'create', fixture);
  docker('volume', 'create', data);
  docker('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:mode=1777',
    '--mount', `type=volume,src=${fixture},dst=/fixtures`, pythonImage, 'python', '-B', '-c', `
import json, os, pathlib
root = pathlib.Path('/fixtures')
rows = []
for i, (account, kind) in enumerate([('synthetic-a', 'group'), ('synthetic-a', 'group'), ('synthetic-a', 'direct'), ('synthetic-b', 'direct')]):
    rows.append(dict(account_id=account, conversation_id='synthetic-peer', conversation_type=kind,
        sender_name='Synthetic sender', sender_qq=11002, ts=1794900000,
        content='QQ import fixture row ' + str(i), source_offset='synthetic-colliding-offset'))
(root / 'qq_messages.json').write_text(json.dumps(rows), encoding='utf-8')
base = dict(platform='qq', displayName='Synthetic QQ export', format='chatlog-keeper-qq-json',
    profilePath='/fixtures/qq_messages.json', allowPlaintext=True, capturedAt='2026-11-17T00:00:00Z')
configs = [dict(base, id='qq-fixture', confirmedConsistentSnapshot=True),
           dict(base, id='qq-unconfirmed', confirmedConsistentSnapshot=False)]
(root / 'sources.json').write_text(json.dumps(configs), encoding='utf-8')
os.chmod(root, 0o700)
os.chown(root, 10001, 10001)
for file in root.iterdir():
    os.chmod(file, 0o600)
    os.chown(file, 10001, 10001)
`);
  docker('run', '-d', '--name', name, '--platform', 'linux/amd64', '--read-only',
    '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::8080', '--mount', `type=volume,src=${fixture},dst=/fixtures,readonly`,
    '--mount', `type=volume,src=${data},dst=/data`,
    '-e', 'SNSBOX_HISTORY_SOURCES_FILE=/fixtures/sources.json',
    '-e', `SNSBOX_ADMIN_PASSWORD=${password}`, appImage);
  started = true;
  const base = `http://${docker('port', name, '8080/tcp').split('\n')[0]}`;
  async function until(fn, label) {
    for (let i = 0; i < 200; i++) {
      const value = await fn().catch(() => false);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  await until(async () => (await fetch(base + '/health')).ok, 'startup');
  const login = await fetch(base + '/api/v1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  const request = (path, options = {}) => fetch(base + path, {
    ...options, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...options.headers },
  });
  const prefix = '/api/v1/history/sources/qq-fixture';
  const refresh = await request(prefix + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(refresh.ok, `refresh status ${refresh.status}`);
  const source = await until(async () => {
    const body = await (await request('/api/v1/history/sources')).json();
    const value = body.items.find(item => item.id === 'qq-fixture');
    return value && !['not_loaded', 'refreshing'].includes(value.status) && value;
  }, 'indexing');
  assert.equal(source.status, 'partial');
  assert.equal(source.platform, 'qq');
  assert.equal(source.sendAllowed, false);
  assert.equal(source.canRefresh, true);
  assert.equal(source.messageCount, 4);
  const conversations = await (await request(prefix + '/conversations')).json();
  assert.equal(conversations.items.length, 3, 'account and kind must isolate equal peer IDs');
  let messages = 0;
  for (const conversation of conversations.items) {
    assert.equal(conversation.platform, 'qq');
    const page = await (await request(prefix + '/conversations/' + conversation.id + '/messages')).json();
    messages += page.items.length;
    assert.equal(new Set(page.items.map(item => item.id)).size, page.items.length);
    for (const item of page.items) assert.equal(item.platform, 'qq');
  }
  assert.equal(messages, 4, 'same-second messages must remain distinct');
  const search = await (await request(prefix + '/messages?query=QQ%20import%20fixture')).json();
  assert.equal(search.items.length, 4);
  const refused = await request('/api/v1/history/sources/qq-unconfirmed/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 200); // Refresh returns its blocked source state.
  const blocked = await refused.json();
  assert.equal(blocked.status, 'snapshot_required');
  assert.equal(blocked.canRefresh, false);
  assert.equal(blocked.generation, null);
  const blockedRead = await request('/api/v1/history/sources/qq-unconfirmed/conversations');
  assert.equal(blockedRead.status, 422);
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, conversations: 3, messages,
    searchResults: 4, sourceState: source.status, unconfirmedRefused: true }));
} finally {
  if (started) docker('rm', '-f', name);
  for (const volume of [fixture, data]) {
    try { docker('volume', 'rm', volume); } catch { /* Preserve the original error. */ }
  }
}
