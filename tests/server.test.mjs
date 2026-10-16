import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { createApp, setPassword } from '../src/server.mjs';
import { validateConfig } from '../src/config.mjs';
import { fetchMessages } from '../src/nodeseek.mjs';
import { sendTelegram } from '../src/telegram.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-web-'));
  const store = new Store(dir);
  await setPassword(store, 'A-strong-password-123');
  const monitor = { busy: false, reset() {}, async tick() {}, async stop() {}, start() {} };
  const server = createApp({ store, monitor });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, options = {}) => fetch(base + path, options);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'NodeSeek-TG' }, body: JSON.stringify({ password: 'A-strong-password-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { store, request, base, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'NodeSeek-TG' } };
}

test('management API requires a session, login rejects bad password, and logout revokes it', async t => {
  const { request, headers } = await fixture(t);
  assert.equal((await request('/api/config')).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
  assert.equal((await request('/api/config', { headers })).status, 200);
  assert.equal((await request('/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await request('/api/config', { headers })).status, 401);
});

test('cross-site writes and missing custom headers cannot change configuration', async t => {
  const { request, headers } = await fixture(t);
  const body = JSON.stringify({ interval: 120 });
  assert.equal((await request('/api/config', { method: 'PUT', headers: { ...headers, Origin: 'https://evil.example' }, body })).status, 403);
  const noHeader = { ...headers }; delete noHeader['X-Requested-With'];
  assert.equal((await request('/api/config', { method: 'PUT', headers: noHeader, body })).status, 403);
});

test('saving configuration masks secrets; empty secret fields preserve existing values', async t => {
  const { request, headers, store } = await fixture(t);
  const body = { cookie: 'session=private-secret', botToken: '123456:ABCdef-secret', userId: '42', chatId: '98765', userAgent: 'Mozilla/5.0', interval: 60, enabled: true };
  const r = await request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  assert.ok(!(await r.text()).includes('private-secret'));
  assert.equal((await request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ interval: 90, cookie: '', botToken: '' }) })).status, 200);
  assert.equal(store.getConfig().cookie, body.cookie);
  const result = await (await request('/api/config', { headers })).json();
  assert.equal(result.hasBotToken, true);
  assert.equal(result.cookie, undefined);
});

test('configuration rejects too-fast polling, header injection and invalid proxies', () => {
  assert.throws(() => validateConfig({ interval: 1 }), /30/);
  assert.throws(() => validateConfig({ cookie: 'a=b\r\nx-evil: 1' }), /换行/);
  assert.throws(() => validateConfig({ nsProxy: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => validateConfig({ enabled: true }), /填写/);
});

test('browser UI is served with CSP; health check exposes no private state', async t => {
  const { request } = await fixture(t);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /NodeSeek/);
  assert.deepEqual(await (await request('/health')).json(), { ok: true });
  assert.equal((await request('/..%2f..%2f.secret_key')).status, 404);
});

test('real HTTP adapters use cookies and plain-text Telegram body; errors redact secrets', async t => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ns') res.end(JSON.stringify({ success: true, msgArray: [{ max_id: 5, sender_id: 7, receiver_id: 42, content: '你好', sender_name: 'Alice' }] }));
    else if (req.url === '/limited') { res.statusCode = 429; res.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 55 }, description: 'SECRET' })); }
    else res.end(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const config = { userId: '42', cookie: 'session=test', userAgent: 'Test Browser', botToken: 'SECRET', chatId: '98765' };
  const messages = await fetchMessages(config, (_, options) => fetch(base + '/ns', options));
  assert.equal(messages[0].text, '你好'); assert.equal(seen[0].headers.cookie, config.cookie);
  assert.equal(await sendTelegram(config, '<script>hello</script>', (_, options) => fetch(base + '/tg', options)), 99);
  assert.equal(JSON.parse(seen[1].body).parse_mode, undefined);
  await assert.rejects(() => sendTelegram(config, 'hello', (_, options) => fetch(base + '/limited', options)), e => e.retryAfter === 55 && !e.message.includes('SECRET'));
});
