import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { defaults } from '../src/store.mjs';
import { filterState, cookieHeader, browserMessages, openBrowser, verifyBrowserIdentity, verifyProxySession, createInboxSource, fillLoginFields, canInspectLogin, loginNodeSeek } from '../src/browser.mjs';
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

test('manual browser stays open while the automation connection is disconnected', { skip: !process.env.CHROMIUM_PATH || !existsSync(process.env.CHROMIUM_PATH), timeout: 45000 }, async t => {
  const session = await openBrowser({}, { manual: true }); t.after(() => session.close());
  await session.page.goto('data:text/html,<title>Manual login fixture</title><input id="password" type="password">');
  assert.equal(await session.page.evaluate(() => navigator.webdriver), false);
  await session.page.locator('#password').fill('fixture-secret');
  await session.disconnect();
  const pages = await session.targets(); assert.ok(pages.some(page => page.title === 'Manual login fixture'));
  await session.connect();
  assert.equal(await session.page.locator('#password').inputValue(), 'fixture-secret');
  await session.close();
  await assert.rejects(() => session.targets());
});

test('login inspection is limited to forum home and inbox after the manual sign-in page', () => {
  for (const url of ['https://www.nodeseek.com/', 'https://nodeseek.com/notification#/message']) assert.equal(canInspectLogin(url), true);
  for (const url of ['https://www.nodeseek.com/?__cf_chl_tk=fixture', 'https://www.nodeseek.com/signIn.html', 'https://www.nodeseek.com/api/account/signIn', 'http://www.nodeseek.com/', 'https://evilnodeseek.com/', 'about:blank']) assert.equal(canInspectLogin(url), false);
});

test('manual verification stays disconnected until confirmation and finds the authenticated tab', { timeout: 5000 }, async () => {
  let connected = true; let confirmed = false; let checks = 0; let closed = false;
  const guest = { url: () => 'https://www.nodeseek.com/', evaluate: async () => null };
  const member = { url: () => 'https://www.nodeseek.com/notification', goto: async () => {}, evaluate: async fn => {
    checks++; return fn.toString().includes('response = await fetch') ? { status: 200, data: { success: true, msgArray: [] } } : fn.toString().includes('navigator.userAgent') ? 'fixture UA' : { id: '42' };
  } };
  const form = { url: () => 'https://www.nodeseek.com/signIn.html', goto: async () => {}, locator: () => ({ first: () => ({ isVisible: async () => false }) }) };
  const session = { page: form, desktopPassword: 'fixture', context: { pages: () => [guest, member], storageState: async () => ({ cookies: [{ name: '_t', value: 'fixture', domain: '.nodeseek.com', expires: -1 }], origins: [] }) }, disconnect: async () => { connected = false; }, connect: async () => { connected = true; }, targets: async () => [{ url: guest.url() }], close: async () => { closed = true; } };
  const io = { log() {}, async confirmLogin() { assert.equal(connected, false); assert.equal(checks, 0); await new Promise(r => setTimeout(r, 40)); assert.equal(checks, 0); confirmed = true; } };
  const result = await loginNodeSeek({ username: 'fixture', password: 'fixture', userId: '42' }, io, { open: async () => session });
  assert.equal(confirmed, true); assert.equal(result.cookie, '_t=fixture'); assert.equal(closed, true);
});

test('cancelling disconnected manual verification closes the browser without inspecting pages', async () => {
  const controller = new AbortController(); let closed = false;
  const form = { url: () => 'https://www.nodeseek.com/signIn.html', goto: async () => {}, locator: () => ({ first: () => ({ isVisible: async () => false }) }) };
  const session = { page: form, disconnect: async () => {}, connect: async () => assert.fail('Must not reconnect after cancellation'), close: async () => { closed = true; } };
  await assert.rejects(() => loginNodeSeek({ username: 'fixture', password: 'fixture' }, { log() {}, signal: controller.signal, confirmLogin: async () => { controller.abort(); } }, { open: async () => session }), /取消/);
  assert.equal(closed, true);
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

test('proxy verification reuses the saved browser session and returns refreshed cookies without a manual login', async () => {
  const state = { cookies: [{ name: 'session', value: 'refreshed', domain: '.nodeseek.com', expires: -1 }], origins: [] };
  const config = { authMode: 'password', userId: '42', nsProxy: 'socks5://fixture:secret@127.0.0.1:1080', browserState: { cookies: [], origins: [] } };
  let closed = false; let inbox = 0;
  const session = { page: { goto: async url => assert.match(url, /notification#/), evaluate: async fn => {
    if (fn.toString().includes('response = await fetch')) { inbox++; return { status: 200, data: { success: true, msgArray: [] } }; }
    return fn.toString().includes('navigator.userAgent') ? 'fixture UA' : { id: '42' };
  } }, context: { storageState: async () => state }, close: async () => { closed = true; } };
  const result = await verifyProxySession(config, null, { open: async candidate => { assert.equal(candidate, config); return session; } });
  assert.equal(inbox, 1); assert.equal(closed, true); assert.equal(result.cookie, 'session=refreshed'); assert.equal(result.userAgent, 'fixture UA');
});

test('proxy verification closes failed browser sessions and refuses a different forum account', async () => {
  for (const identity of [null, { id: '99' }]) {
    let closed = false;
    await assert.rejects(() => verifyProxySession({ authMode: 'password', userId: '42', browserState: {} }, null, { open: async () => ({
      page: { goto: async () => {}, evaluate: async () => identity }, close: async () => { closed = true; }
    }) }));
    assert.equal(closed, true);
  }
});

test('Cookie-mode proxy verification uses the candidate proxy and never opens a browser', async () => {
  const candidate = { authMode: 'cookie', userId: '42', cookie: 'fixture', nsProxy: 'socks5://127.0.0.1:1080' };
  const result = await verifyProxySession(candidate, async (_, options) => {
    assert.equal(options.proxy, candidate.nsProxy);
    return { status: 200, ok: true, json: async () => ({ success: true, msgArray: [] }) };
  }, { open: async () => assert.fail('Cookie mode should not launch a browser') });
  assert.deepEqual(result, {});
});

test('cancelling proxy verification closes the active browser and interrupts navigation', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let closed = false; let rejectNavigation;
  const session = {
    page: { goto: () => new Promise((_, reject) => { rejectNavigation = reject; controller.abort(); }) },
    close: async () => { closed = true; rejectNavigation?.(new Error('Browser closed')); }
  };
  await assert.rejects(() => verifyProxySession({ authMode: 'password', browserState: {} }, null, { signal: controller.signal, open: async () => session }), /Browser closed/);
  assert.equal(closed, true);
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
