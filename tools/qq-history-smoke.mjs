// Synthetic-only QQ export -> Rust index -> authenticated HTTP integration.
// No NAS paths, platform login, live messages, or real credentials are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appImage = process.argv[2] || 'snsbox:0.1.0';
const pythonImage = process.argv[3] || 'python:3.12-slim-bookworm';
const name = `snsbox-qq-history-smoke-${randomUUID().slice(0, 8)}`;
const fixture = `${name}-fixture`, data = `${name}-data`;
const password = randomUUID();
const rootPath = fileURLToPath(new URL('../', import.meta.url));
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let started = false;
try {
  docker('volume', 'create', fixture);
  docker('volume', 'create', data);
  const expected = JSON.parse(docker('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:mode=1777',
    '--mount', `type=volume,src=${fixture},dst=/fixtures`,
    '--mount', `type=bind,src=${rootPath},dst=/repo,readonly`, pythonImage, 'python', '-B', '-c', `
import json, os, pathlib, subprocess, sys
root = pathlib.Path('/fixtures')
rows = []
for i, (account, kind) in enumerate([('synthetic-a', 'group'), ('synthetic-a', 'group'), ('synthetic-a', 'direct'), ('synthetic-b', 'direct')]):
    rows.append(dict(account_id=account, conversation_id='synthetic-peer', conversation_type=kind,
        sender_name='Synthetic sender', sender_qq=11002, ts=1794900000,
        content='QQ import fixture row ' + str(i), source_offset='synthetic-colliding-offset'))
for i in range(120):
    rows.append(dict(account_id='synthetic-a', conversation_id='synthetic-peer', conversation_type='group',
        sender_name='Synthetic sender', sender_qq=11002, ts=1794899000+i,
        content=('Context anchor fixture' if i == 20 else 'Context row ' + str(i))))
(root / 'qq_messages.json').write_text(json.dumps(rows), encoding='utf-8')
base = dict(platform='qq', displayName='Synthetic QQ export', format='chatlog-keeper-qq-json',
    profilePath='/fixtures/qq_messages.json', allowPlaintext=True, capturedAt='2026-11-17T00:00:00Z')
configs = [dict(base, id='qq-fixture', confirmedConsistentSnapshot=True),
           dict(base, id='qq-unconfirmed', confirmedConsistentSnapshot=False)]
tool = '/repo/tools/qq-decrypted/'
subprocess.run([sys.executable, '-B', tool+'fixture.py', '--output-dir', '/fixtures/plain'], check=True, capture_output=True)
expected = json.loads((root/'plain/fixture-report.json').read_text())
for label, info in expected['accounts'].items():
    destination = root / ('converted-' + label)
    subprocess.run([sys.executable, '-B', tool+'convert.py', '--database', str(root/'plain'/info['database']),
        '--account-id', info['accountId'], '--output-dir', str(destination), '--active-root', '/active-never-used',
        '--confirmed-independent-copy', '--source-id', 'qq-' + label,
        '--container-path', str(destination/'qq_messages.json')], check=True, capture_output=True)
    configs.extend(json.loads((destination/'history-sources.json').read_text()))
(root / 'sources.json').write_text(json.dumps(configs), encoding='utf-8')
for parent, directories, files in os.walk(root):
    os.chmod(parent, 0o700)
    os.chown(parent, 10001, 10001)
    for name in files:
        file = pathlib.Path(parent)/name
        os.chmod(file, 0o600)
        os.chown(file, 10001, 10001)
print(json.dumps(expected))
`));
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
  assert.equal(source.messageCount, 124);
  const conversations = await (await request(prefix + '/conversations')).json();
  assert.equal(conversations.items.length, 3, 'account and kind must isolate equal peer IDs');
  let messages = 0;
  for (const conversation of conversations.items) {
    assert.equal(conversation.platform, 'qq');
    const page = await (await request(prefix + '/conversations/' + conversation.id + '/messages?limit=200')).json();
    messages += page.items.length;
    assert.equal(new Set(page.items.map(item => item.id)).size, page.items.length);
    for (const item of page.items) assert.equal(item.platform, 'qq');
  }
  assert.equal(messages, 124, 'same-second messages must remain distinct');
  const search = await (await request(prefix + '/messages?query=QQ%20import%20fixture')).json();
  assert.equal(search.items.length, 4);
  const hitSearch = await (await request(prefix + '/messages?query=Context%20anchor%20fixture')).json();
  const hit = hitSearch.items[0];
  assert.ok(hit);
  const messagePath = prefix + '/conversations/' + hit.conversationId + '/messages';
  const latest = await (await request(messagePath)).json();
  assert.equal(latest.items.some(item => item.id === hit.id), false, 'anchor must be outside the latest page');
  const contextPath = messagePath + '/' + hit.id + '/context';
  const contextResponse = await request(contextPath + '?limit=20&generation=' + source.generation);
  assert.equal(contextResponse.status, 200);
  const context = await contextResponse.json();
  assert.equal(context.anchorMessageId, hit.id);
  assert.equal(context.items.length, 20);
  assert.equal(context.items.some(item => item.id === hit.id), true);
  assert.equal(context.hasNewer, true);
  assert.ok(context.nextCursor);
  const older = await (await request(messagePath + '?limit=20&cursor=' + encodeURIComponent(context.nextCursor))).json();
  const seen = new Set(context.items.map(item => item.id));
  assert.ok(older.items.length > 0);
  assert.equal(older.items.some(item => seen.has(item.id)), false);
  const wrongConversation = conversations.items.find(item => item.id !== hit.conversationId);
  assert.equal((await request(prefix + '/conversations/' + wrongConversation.id + '/messages/' + hit.id + '/context?generation=' + source.generation)).status, 404);
  assert.equal((await request(contextPath + '?generation=stale-fixture-generation')).status, 409);
  const refused = await request('/api/v1/history/sources/qq-unconfirmed/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 200); // Refresh returns its blocked source state.
  const blocked = await refused.json();
  assert.equal(blocked.status, 'snapshot_required');
  assert.equal(blocked.canRefresh, false);
  assert.equal(blocked.generation, null);
  const blockedRead = await request('/api/v1/history/sources/qq-unconfirmed/conversations');
  assert.equal(blockedRead.status, 422);
  const decryptedResults = [];
  for (const [label, stats] of Object.entries(expected.accounts)) {
    const id = 'qq-' + label;
    const path = '/api/v1/history/sources/' + id;
    assert.equal((await request(path + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    const imported = await until(async () => {
      const body = await (await request('/api/v1/history/sources')).json();
      const item = body.items.find(item => item.id === id);
      return item && !['not_loaded', 'refreshing'].includes(item.status) && item;
    }, 'decrypted indexing');
    assert.equal(imported.status, 'partial');
    assert.equal(imported.messageCount, stats.messages);
    assert.equal(imported.conversationCount, stats.conversations);
    assert.equal(imported.format, 'snsbox-qq-decrypted-v1');
    const tail = await (await request(path + '/messages?query=' + encodeURIComponent(expected.longTailMarker))).json();
    assert.equal(tail.items.length, label === 'account-a' ? 1 : 0, 'long tail must survive conversion and remain source-scoped');
    if (label === 'account-a') {
      const long = tail.items[0];
      assert.ok(long.segments[0].text.length > 5000);
      const around = await (await request(path + '/conversations/' + long.conversationId + '/messages/' + long.id + '/context?generation=' + imported.generation)).json();
      assert.ok(around.items.some(item => item.id === long.id));
      const all = await (await request(path + '/conversations/' + long.conversationId + '/messages?limit=200')).json();
      assert.equal(all.items.filter(item => item.segments.some(segment => segment.type === 'unknown')).length, stats.unreadable);
      assert.equal(JSON.stringify(all).includes('never-fetch.invalid'), false);
    }
    decryptedResults.push({ source: label, messages: imported.messageCount });
  }
  console.log(JSON.stringify({ ok: true, syntheticOnly: true, conversations: 3, messages,
    searchResults: 4, sourceState: source.status, unconfirmedRefused: true, contextLocated: true,
    decryptedSqlite: decryptedResults, longTailSearch: true }));
} finally {
  if (started) docker('rm', '-f', name);
  for (const volume of [fixture, data]) {
    try { docker('volume', 'rm', volume); } catch { /* Preserve the original error. */ }
  }
}
