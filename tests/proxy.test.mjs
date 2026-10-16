import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';
import { createTransport } from '../src/transport.mjs';
import { openBrowser } from '../src/browser.mjs';
import { openProxy } from '../src/proxy.mjs';
import { connect } from 'node:net';
import { socksFixture } from './helpers/socks.mjs';

test('SOCKS5 sharing labels are removed and invalid proxy paths are rejected', () => {
  assert.equal(validateConfig({ nsProxy: 'socks5://user:pass@127.0.0.1:1080#label' }).nsProxy, 'socks5://user:pass@127.0.0.1:1080');
  assert.throws(() => validateConfig({ nsProxy: 'socks5://localhost:1080/path' }), /代理/);
});

async function upstream(t) {
  const server = createServer((req, res) => res.end(req.headers.host + ':through-socks'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://proxy-fixture.invalid:${server.address().port}`;
}

test('HTTP transport authenticates SOCKS5, resolves target remotely, and closes its bridge', { timeout: 15000 }, async t => {
  const target = await upstream(t); const socks = await socksFixture(t);
  const transport = createTransport(); t.after(() => transport.close());
  const response = await transport.request(target, { proxy: socks.url, signal: AbortSignal.timeout(5000) });
  assert.match(await response.text(), /through-socks/);
  assert.equal(socks.seen[0].user, 'fixture'); assert.equal(socks.seen[0].host, 'proxy-fixture.invalid');
  await transport.close();
});

test('SOCKS5 authentication failure never falls back to a direct connection', { timeout: 10000 }, async t => {
  const target = await upstream(t); const socks = await socksFixture(t, { reject: true });
  const transport = createTransport(); t.after(() => transport.close());
  const response = await transport.request(target, { proxy: socks.url, signal: AbortSignal.timeout(5000) });
  assert.ok(response.status >= 500); assert.ok(!(await response.text()).includes('test secret'));
  assert.equal(socks.seen.length, 0);
});

test('SOCKS bridge listens only on loopback and releases its listening port', async () => {
  const bridge = await openProxy('socks5://fixture:secret@127.0.0.1:1080');
  const url = new URL(bridge.url); assert.equal(url.hostname, '127.0.0.1');
  await bridge.close(); await bridge.close();
  const socket = connect(Number(url.port), url.hostname);
  const [error] = await once(socket, 'error'); assert.equal(error.code, 'ECONNREFUSED');
});

test('real Chromium loads a page through an authenticated SOCKS5 proxy', { skip: !process.env.CHROMIUM_PATH || !existsSync(process.env.CHROMIUM_PATH), timeout: 30000 }, async t => {
  const target = await upstream(t); const socks = await socksFixture(t);
  const session = await openBrowser({ nsProxy: socks.url }); t.after(() => session.close());
  await session.page.goto(target);
  assert.match(await session.page.textContent('body'), /through-socks/);
  assert.ok(socks.seen.some(request => request.host === 'proxy-fixture.invalid'));
});
