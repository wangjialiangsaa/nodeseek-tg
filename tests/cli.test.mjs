import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { configure, runCommand } from '../src/cli.mjs';
import { healthy } from '../src/health.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ns-cli-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}
const values = ['123456:ABCdef-secret', '98765', '42', '2', 'session=secret', 'Mozilla/5.0 test', '60', '', '', 'y'];
function scripted(answers) {
  const prompts = []; const output = [];
  return { prompts, output, ask: async (label, options = {}) => { prompts.push({ label, ...options }); assert.ok(answers.length, 'unexpected extra prompt'); return answers.shift(); }, log: text => output.push(text) };
}
test('SSH wizard saves a complete configuration and marks every credential input as secret', async t => {
  const { store } = fixture(t); const io = scripted([...values]);
  await configure(store, io);
  assert.equal(store.getConfig().enabled, true);
  assert.equal(store.getConfig().cookie, 'session=secret');
  assert.equal(store.getConfig().userId, '42');
  for (const key of ['Bot Token', 'NodeSeek Cookie', 'NodeSeek 代理', 'Telegram 代理']) assert.ok(io.prompts.find(p => p.label.includes(key))?.secret);
  assert.ok(!io.output.join('\n').includes('session=secret'));
  assert.ok(!io.output.join('\n').includes('ABCdef-secret'));
});
test('pressing Enter preserves existing secrets, baseline and pending messages; minus removes proxy', async t => {
  const { store } = fixture(t);
  await configure(store, scripted([...values]));
  store.saveConfig({ ...store.getConfig(), nsProxy: 'http://secret:password@127.0.0.1:8080' });
  store.ingest([{ id: '1', sender: 'A', text: 'old' }]);
  store.ingest([{ id: '2', sender: 'A', text: 'new' }]);
  const io = scripted(['', '', '', '', '', '', '', '-', '', '']);
  await configure(store, io);
  assert.equal(store.getConfig().cookie, 'session=secret');
  assert.equal(store.getConfig().nsProxy, '');
  assert.equal(store.pending().length, 1);
  assert.ok(!JSON.stringify(io.prompts).includes('session=secret'));
});
test('invalid or cancelled configuration leaves the saved configuration untouched', async t => {
  const { store } = fixture(t); await configure(store, scripted([...values]));
  const before = store.getConfig();
  await assert.rejects(() => configure(store, scripted(['', '', '', '', '', '', '1', '', '', 'y'])), /30/);
  assert.deepEqual(store.getConfig(), before);
  await assert.rejects(() => configure(store, { ask: async () => { throw new Error('cancelled'); }, log() {} }), /cancelled/);
  assert.deepEqual(store.getConfig(), before);
});

test('password wizard hides password and saves only a successfully verified session', async t => {
  const { store, directory } = fixture(t);
  const io = scripted(['123456:ABCdef-secret', '98765', '42', '1', 'example-user', 'test-password-unique', '60', '', '', 'y']);
  const browserState = { cookies: [{ name: '_t', value: 'browser-secret-unique', domain: '.nodeseek.com', path: '/' }], origins: [] };
  let called = 0;
  await configure(store, io, { login: async config => {
    called++; assert.equal(config.username, 'example-user'); assert.equal(config.password, 'test-password-unique');
    return { cookie: '_t=browser-secret-unique', userAgent: 'Chromium test', browserState };
  } });
  assert.equal(called, 1);
  assert.equal(store.getConfig().authMode, 'password');
  assert.equal(store.getConfig().password, 'test-password-unique');
  assert.equal(store.getConfig().browserState.cookies[0].value, 'browser-secret-unique');
  assert.ok(io.prompts.find(p => p.label.includes('NodeSeek 密码'))?.secret);
  const publicText = JSON.stringify(store.publicConfig());
  for (const secret of ['test-password-unique', 'browser-secret-unique']) {
    assert.ok(!publicText.includes(secret)); assert.ok(!io.output.join('\n').includes(secret));
    for (const file of ['state.sqlite', 'state.sqlite-wal']) {
      try { assert.ok(!readFileSync(join(directory, file)).includes(Buffer.from(secret))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
});

test('failed password verification preserves saved credentials, baseline and pending outbox', async t => {
  const { store } = fixture(t); await configure(store, scripted([...values]));
  store.ingest([{ id: '1', sender: 'A', text: 'old' }]); store.ingest([{ id: '2', sender: 'A', text: 'new' }]);
  const before = store.getConfig();
  const io = scripted(['', '', '', '1', 'another-user', 'other-password', '', '', '', 'y']);
  await assert.rejects(() => configure(store, io, { login: async () => { throw new Error('需要人工验证'); } }), /人工验证/);
  assert.deepEqual(store.getConfig(), before); assert.equal(store.stats().pending, 1); assert.equal(store.stats().baseline, true);
});
test('CLI status masks credentials and connectivity tests use saved configuration', async t => {
  const { store } = fixture(t); await configure(store, scripted([...values]));
  const output = []; let sent = 0;
  const deps = { store, io: { log: x => output.push(x) }, fetchInbox: async config => { assert.equal(config.cookie, 'session=secret'); return []; }, sendMessage: async (_, text) => { assert.match(text, /测试/); sent++; } };
  await runCommand('status', deps);
  await runCommand('test-nodeseek', deps); await runCommand('test-telegram', deps);
  assert.equal(sent, 1);
  assert.ok(!output.join('\n').includes('session=secret'));
  assert.ok(!output.join('\n').includes('ABCdef-secret'));
});

test('stdin login overrides stay in memory until verification and never replace settings on failure', async t => {
  const { store } = fixture(t); await configure(store, scripted([...values]));
  const before = store.getConfig();
  const credentials = { username: 'example-user', password: 'stdin-secret', nsProxy: 'socks5://user:pass@127.0.0.1:1080#label' };
  await assert.rejects(() => runCommand('login', { store, credentials, io: { log() {} }, login: async config => { assert.equal(config.password, 'stdin-secret'); assert.equal(config.nsProxy, 'socks5://user:pass@127.0.0.1:1080'); throw new Error('cancelled'); } }), /cancelled/);
  assert.deepEqual(store.getConfig(), before);
  await runCommand('login', { store, credentials, io: { log() {} }, login: async () => ({ cookie: '_t=verified', browserState: { cookies: [], origins: [] }, userAgent: 'Browser' }) });
  assert.equal(store.getConfig().authMode, 'password'); assert.equal(store.getConfig().password, 'stdin-secret');
  assert.equal(store.getConfig().nsProxy, 'socks5://user:pass@127.0.0.1:1080');
  assert.equal(store.getConfig().botToken, before.botToken);
});

test('cancelling while successful login is resolving never saves the new session', async t => {
  const { store } = fixture(t); await configure(store, scripted([...values]));
  const before = store.getConfig(); const controller = new AbortController();
  const io = { log() {}, signal: controller.signal };
  await assert.rejects(() => runCommand('login', { store, io, credentials: { username: 'example', password: 'secret' }, login: async () => { controller.abort(); return { cookie: '_t=new', browserState: { cookies: [], origins: [] } }; } }), /取消/);
  assert.deepEqual(store.getConfig(), before);
});
test('container health uses daemon heartbeat without any HTTP server or published ports', t => {
  const { directory } = fixture(t);
  assert.equal(healthy(directory, 100000), false);
  writeFileSync(join(directory, '.heartbeat'), '90000');
  assert.equal(healthy(directory, 100000), true);
  assert.equal(healthy(directory, 200000), false);
  const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.ok(!/^\s+ports:/m.test(compose));
});
