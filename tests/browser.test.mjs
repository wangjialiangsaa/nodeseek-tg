import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { defaults } from '../src/store.mjs';
import { filterState, cookieHeader, browserMessages, openBrowser, verifyBrowserIdentity, createInboxSource, fillLoginFields } from '../src/browser.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { once } from 'node:events';
import { createCipheriv } from 'node:crypto';

test('password mode rejects missing credentials but does not require manually copied Cookie or User-Agent before login', () => {
  const input = { authMode: 'password', username: 'example', password: 'test secret', userId: '42', botToken: '123456:ABCdef-secret', chatId: '98765', enabled: true };
  assert.equal(validateConfig(input, defaults).authMode, 'password');
  assert.throws(() => validateConfig({ ...input, password: '' }, defaults), /密码/);
  assert.throws(() => validateConfig({ ...input, authMode: 'invalid' }, defaults), /登录方式/);
  assert.throws(() => validateConfig({ ...input, password: 'bad\nvalue' }, defaults), /换行/);
  assert.equal(validateConfig({ ...input, password: ' leading and trailing spaces ' }, defaults).password, ' leading and trailing spaces ');
});

test('only live forum cookies and forum local storage enter the encrypted session', () => {
  const makeCookie = (name, domain, expires = -1) => ({ name, domain, value: 'secret', expires, path: '/' });
  const state = filterState({ cookies: [makeCookie('_t', '.nodeseek.com'), makeCookie('cf_clearance', 'www.nodeseek.com'), makeCookie('dead', '.nodeseek.com', 1), makeCookie('third-party', '.example.com'), makeCookie('lookalike', 'evilnodeseek.com')], origins: [{ origin: 'https://www.nodeseek.com', localStorage: [] }, { origin: 'https://example.com', localStorage: [] }] });
  assert.equal(state.cookies.length, 3); assert.equal(state.origins.length, 1);
  assert.equal(cookieHeader(state), '_t=secret; cf_clearance=secret');
});

test('browser inbox treats HTML, login expiry and malformed payloads as failures', async () => {
  for (const [reply, code] of [[{ status: 403, data: null }, 'blocked'], [{ status: 200, data: null }, 'blocked'], [{ status: 401, data: null }, 'auth'], [{ status: 200, data: { success: true } }, 'format']]) {
    await assert.rejects(() => browserMessages({ page: { evaluate: async () => reply } }, { userId: '42' }), e => e.code === code);
  }
});

test('browser sign-in rejects missing identity or an account ID that would silently filter out its inbox', async () => {
  const config = { userId: '42' };
  await assert.rejects(() => verifyBrowserIdentity({ page: { evaluate: async () => ({ id: '88' }) } }, config), /88/);
  await assert.rejects(() => verifyBrowserIdentity({ page: { evaluate: async () => null } }, config), /身份/);
  await verifyBrowserIdentity({ page: { evaluate: async () => ({ id: '42' }) } }, config);
});

test('a stale browser read never overwrites a newer encrypted login state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ns-race-')); const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const state = value => ({ cookies: [{ name: '_t', value, domain: '.nodeseek.com', path: '/', expires: -1 }], origins: [] });
  store.saveConfig({ ...defaults, authMode: 'password', username: 'example', userId: '42', browserState: state('old') });
  let opened = 0;
  const source = createInboxSource(store, null, { open: async config => {
    const loaded = config.browserState; opened++;
    return { browser: { isConnected: () => true }, page: { goto: async () => {}, evaluate: async () => ({ status: 200, data: { success: true, msgArray: [] } }) }, context: { storageState: async () => { if (opened === 1) store.saveConfig({ ...store.getConfig(), browserState: state('new') }); return loaded; } }, close: async () => {} };
  } });
  t.after(() => source.close());
  await assert.rejects(() => source.fetch(store.getConfig()), e => e.code === 'network');
  assert.equal(store.getConfig().browserState.cookies[0].value, 'new');
  await source.fetch(store.getConfig());
  assert.equal(opened, 2);
  assert.equal(store.getConfig().browserState.cookies[0].value, 'new');
});

test('real Chromium desktop reads an authenticated fixture inbox and serves the temporary verification view', { skip: !process.env.CHROMIUM_PATH || !existsSync(process.env.CHROMIUM_PATH) }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/api/notification/message/list') {
      if (!req.headers.cookie?.includes('session=fixture')) { res.writeHead(401).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, msgArray: [{ max_id: 8, receiver_id: 42, sender_id: 7, content: 'fixture inbox' }] }));
    } else { res.setHeader('Set-Cookie', 'session=fixture; HttpOnly; SameSite=Lax'); res.end('<html><body>Login fixture</body></html>'); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const session = await openBrowser({ browserState: null, nsProxy: '' }, { desktop: true });
  t.after(() => session.close());
  await session.page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await browserMessages(session, { userId: '42' }))[0].text, 'fixture inbox');
  const state = await session.context.storageState(); assert.ok(state.cookies.some(c => c.name === 'session'));
  const form = '<input id="search-site" type="text"><input id="stacked-email" type="text"><input id="stacked-password" type="password">';
  await session.page.route('https://www.nodeseek.com/signIn.html', route => route.fulfill({ contentType: 'text/html', body: form }));
  await session.page.goto('https://www.nodeseek.com/signIn.html');
  assert.equal(await fillLoginFields(session.page, { username: 'fixture-user', password: 'fixture-pass' }), true);
  assert.equal(await session.page.locator('#stacked-email').inputValue(), 'fixture-user');
  assert.equal(await session.page.locator('#stacked-password').inputValue(), 'fixture-pass');
  assert.equal(await session.page.locator('#search-site').inputValue(), '', 'Never fill the header search field');
  await session.page.route('https://example.com/*', route => route.fulfill({ contentType: 'text/html', body: form }));
  await session.page.goto('https://example.com/signIn.html');
  assert.equal(await fillLoginFields(session.page, { username: 'fixture-user', password: 'fixture-pass' }), false);
  assert.equal(await session.page.locator('#stacked-password').inputValue(), '');
  let response;
  for (let n = 0; n < 30; n++) {
    try { response = await fetch('http://127.0.0.1:6080/vnc.html'); if (response.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(response?.status, 200);
  assert.match(await response.text(), /noVNC/);
  assert.match(session.desktopPassword, /^[A-Za-z0-9_-]{8}$/);
  const socket = new WebSocket('ws://127.0.0.1:6080/websockify', ['binary']); socket.binaryType = 'arraybuffer';
  await once(socket, 'open');
  const [greeting] = await once(socket, 'message'); assert.match(Buffer.from(greeting.data).toString(), /^RFB/);
  socket.send(Buffer.from('RFB 003.008\n'));
  const [security] = await once(socket, 'message');
  assert.deepEqual([...new Uint8Array(security.data)], [1, 2], 'RFB must offer password auth and never no-auth');
  socket.send(Uint8Array.from([2]));
  const [challenge] = await once(socket, 'message');
  const key = Buffer.from(session.desktopPassword).map(byte => {
    let reversed = 0; for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((byte >> bit) & 1); return reversed;
  });
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  socket.send(Buffer.concat([cipher.update(Buffer.from(challenge.data)), cipher.final()]));
  const [authenticated] = await once(socket, 'message');
  assert.deepEqual([...new Uint8Array(authenticated.data)], [0, 0, 0, 0], 'Generated desktop password must authenticate');
  socket.close();
  await session.close();
  await assert.rejects(() => fetch('http://127.0.0.1:6080/vnc.html'));
});
