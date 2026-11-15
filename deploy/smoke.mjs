// One isolated HTTP/adapter/persistence smoke. No real account or profile is used.
// Requires Docker and a built image: node deploy/smoke.mjs [snsbox:0.1.0]
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const image = process.argv[2] || 'snsbox:0.1.0';
const name = `snsbox-smoke-${randomUUID().slice(0, 8)}`;
const dir = await mkdtemp(join(tmpdir(), 'snsbox-smoke-'));
const token = randomUUID();
const password = randomUUID();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQJ0AAAAASUVORK5CYII=', 'base64');
let sends = 0;
let mediaReads = 0;
let started = false;
const observed=[];
const fixture = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  const url = new URL(req.url, 'http://fixture');
  observed.push(`${req.method} ${url.pathname}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/v1/accounts/wx') return json({ authenticated: true, connection: 'online' });
  if (url.pathname === '/v1/accounts/wx/threads') return json({ items: [{ id: 'filehelper', kind: 'direct', displayName: 'Synthetic File Transfer' }], nextCursor: null });
  if (url.pathname === '/v1/accounts/wx/threads/filehelper/messages') return json({ items: [
    { id: 'text-local', serverId: '9007199254740993', threadId: 'filehelper', senderId: 'fixture', direction: 'incoming', type: 1, body: 'x'.repeat(200) + 'needle-after-160', createdAt: '2026-11-15T10:00:00Z' },
    { id: 'image-local', serverId: '9007199254740994', threadId: 'filehelper', senderId: 'fixture', direction: 'incoming', type: 3, body: null, createdAt: '2026-11-15T10:00:01Z' },
  ], nextCursor: null });
  if (url.pathname === '/v1/accounts/wx/events') return json({ items: [], nextCursor: '0' });
  if (url.pathname === '/v1/accounts/wx/messages/image-local/media') return json({ items: [{ id: 'image-asset', kind: 'image', state: 'available' }] });
  if (url.pathname === '/v1/accounts/wx/media/image-asset/content') { mediaReads++; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return; }
  if (url.pathname === '/v1/accounts/wx/sends' && req.method === 'POST') {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.threadId !== 'filehelper' || body.text !== 'fixture send') { res.writeHead(400).end(); return; }
    sends++;
    return json({ id: 'send-1', state: 'accepted', serverId: '9007199254740995' });
  }
  if (url.pathname === '/v1/accounts/wx/sends/send-1') return json({ id: 'send-1', state: 'accepted', serverId: '9007199254740995' });
  const milky = data => json({ status: 'ok', retcode: 0, data });
  if (url.pathname === '/api/get_login_info') return milky({ uin: 10001, nickname: 'Synthetic QQ' });
  if (url.pathname === '/api/get_friend_list') return milky({ friends: [{ user_id: 10002, nickname: 'QQ fixture', remark: '' }] });
  if (url.pathname === '/api/get_group_list') return milky({ groups: [] });
  if (url.pathname === '/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: milky_event\r\ndata: ${JSON.stringify({ event_type: 'message_receive', self_id: 10001, data: { message_scene: 'friend', peer_id: 10002, sender_id: 10002, message_seq: 10, time: 1794736800, segments: [{ type: 'text', data: { text: 'QQ SSE fixture' } }] } })}\r\n\r\n`);
    return;
  }
  res.writeHead(404).end();
});
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { const result = await fn().catch(() => false); if (result) return result; await delay(100); } throw new Error(`Timed out: ${label}`); }
try {
  await new Promise(resolve => fixture.listen(0, '0.0.0.0', resolve));
  const port = fixture.address().port;
  await writeFile(join(dir, 'token'), token);
  await writeFile(join(dir, 'accounts.json'), JSON.stringify([
    { id: 'wx', platform: 'wechat', displayName: 'Synthetic WeChat', baseUrl: `http://host.docker.internal:${port}`, upstreamAccountId: 'wx', tokenFile: '/fixture/token' },
    { id: 'qq', platform: 'qq', displayName: 'Synthetic QQ', baseUrl: `http://host.docker.internal:${port}`, tokenFile: '/fixture/token' },
  ]));
  docker('run', '-d', '--name', name, '--platform', 'linux/amd64', '--read-only', '--tmpfs', '/tmp:mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '-p', '127.0.0.1::8080', ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '-v', `${dir}:/fixture:ro`, '-e', 'SNSBOX_ACCOUNTS_FILE=/fixture/accounts.json', '-e', `SNSBOX_ADMIN_PASSWORD=${password}`, image);
  started = true;
  const address = docker('port', name, '8080/tcp').split('\n')[0];
  let base = `http://${address}`;
  let cookie = '';
  let csrf = '';
  async function request(path, options = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers };
    return fetch(base + path, { ...options, headers });
  }
  async function signin() {
    const res = await request('/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    csrf = (await res.json()).csrfToken;
    assert.ok(csrf);
  }
  await until(async () => (await request('/health')).ok, 'health');
  assert.equal((await request('/api/v1/accounts')).status, 401);
  await signin();
  const list = await until(async () => { const p = await (await request('/api/v1/conversations')).json(); return p.items?.length >= 2 && p.items; }, 'both configured adapters');
  const wx = list.find(c => c.accountId === 'wx');
  const qq = list.find(c => c.accountId === 'qq');
  assert.ok(wx && qq);
  const history = await until(async () => { const p = await (await request(`/api/v1/conversations/${wx.id}/messages`)).json(); return p.items?.length === 2 && p.items; }, 'WeChat history');
  assert.equal(history.find(m => m.segments[0].type === 'text').upstreamId, 'server:9007199254740993');
  const search = await (await request('/api/v1/messages?query=needle-after-160')).json();
  assert.equal(search.items.length, 1);
  const media = history.find(m => m.segments[0].type === 'image').segments[0].url;
  assert.ok(Buffer.from(await (await request(media)).arrayBuffer()).equals(png));
  assert.equal((await request(media, { headers: { Range: 'bytes=0-7' } })).status, 206);
  assert.equal(mediaReads, 1, 'subsequent media reads must use the private local cache');
  await until(async () => (await (await request(`/api/v1/conversations/${qq.id}/messages`)).json()).items.some(m => m.segments[0].text === 'QQ SSE fixture'), 'CRLF QQ event');
  const sendPath = `/api/v1/conversations/${wx.id}/messages`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-key' }, body: JSON.stringify({ segments: [{ type: 'text', text: 'fixture send' }] }) };
  assert.equal((await request(sendPath, { ...options, headers: { ...options.headers, 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await request(sendPath, { ...options, headers: { ...options.headers, Origin: 'https://invalid.example' } })).status, 403);
  const first = await request(sendPath, options); assert.equal(first.status, 202); const message = await first.json();
  const second = await request(sendPath, options); assert.equal(second.status, 202); assert.equal((await second.json()).id, message.id);
  const conflict = await request(sendPath, { ...options, body: JSON.stringify({ segments: [{ type: 'text', text: 'changed request' }] }) }); assert.equal(conflict.status, 409);
  await until(async () => (await (await request(`/api/v1/conversations/${wx.id}/messages`)).json()).items.find(m => m.id === message.id)?.status === 'accepted', 'accepted send receipt');
  assert.equal(sends, 1);
  docker('restart', name);
  base = `http://${docker('port', name, '8080/tcp').split('\n')[0]}`;
  await until(async () => (await request('/health')).ok, 'restart');
  assert.equal((await request('/api/v1/session')).status, 401, 'restart must revoke old browser sessions');
  cookie = ''; csrf = ''; await signin();
  const replay = await request(sendPath, options); assert.equal(replay.status, 202); assert.equal((await replay.json()).id, message.id); assert.equal(sends, 1, 'restart replay must not resubmit');
  console.log('PASS: isolated AMD64 runtime, auth/CSRF, both adapter shapes, CRLF SSE, history/search, authenticated cached media/Range, durable idempotency and restart. Synthetic data only.');
} catch(error) {
  console.error('Synthetic fixture requests:', observed);
  if(started) console.error(docker('logs',name));
  throw error;
} finally {
  if (started) docker('rm', '-f', '-v', name);
  fixture.closeAllConnections(); fixture.close();
  await rm(dir, { recursive: true, force: true });
}
