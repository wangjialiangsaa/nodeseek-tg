import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { normalizeMessages, NodeSeekError } from '../src/nodeseek.mjs';
import { Monitor } from '../src/monitor.mjs';

const row = (id, extra = {}) => ({ max_id: id, sender_id: 7, receiver_id: 42, sender_name: 'Alice', content: '<b>Hello</b>', ...extra });
const config = { enabled: true, userId: '42', cookie: 'session=secret', botToken: '12345:secret', chatId: '98765', interval: 60, userAgent: 'Browser', nsProxy: '', tgProxy: '' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-tg-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig(config);
  return { store, dir };
}

test('parses received messages and excludes my outgoing messages and unrelated users', () => {
  const messages = normalizeMessages({ success: true, msgArray: [row(11), row(12, { sender_id: 42, receiver_id: 7 }), row(13, { receiver_id: 88 })] }, '42');
  assert.deepEqual(messages.map(m => m.id), ['11']);
  assert.equal(messages[0].text, 'Hello');
  assert.equal(messages[0].sender, 'Alice');
});

test('malformed API data and login errors never silently become an empty inbox', () => {
  assert.throws(() => normalizeMessages({ success: false, message: '请先登录' }, '42'), e => e instanceof NodeSeekError && e.code === 'auth');
  assert.throws(() => normalizeMessages({ success: true }, '42'), /结构/);
  assert.throws(() => normalizeMessages({ success: true, msgArray: [row(null)] }, '42'), /结构/);
});

test('baseline skips existing messages; subsequent messages survive database restart without duplicates', t => {
  const { store, dir } = fixture(t);
  const messages = normalizeMessages({ success: true, msgArray: [row(1)] }, '42');
  assert.equal(store.ingest(messages), 0);
  assert.equal(store.ingest(normalizeMessages({ success: true, msgArray: [row(2), row(1)] }, '42')), 1);
  store.close();
  const reopened = new Store(dir);
  try {
    assert.equal(reopened.ingest(normalizeMessages({ success: true, msgArray: [row(2)] }, '42')), 0);
    assert.equal(reopened.pending().length, 1);
  } finally { reopened.close(); }
});

test('secrets are encrypted at rest and excluded from public configuration', t => {
  const { store, dir } = fixture(t);
  assert.equal(store.getConfig().cookie, config.cookie);
  assert.equal(store.publicConfig().cookie, undefined);
  assert.equal(store.publicConfig().botToken, undefined);
  const files = ['state.sqlite', 'state.sqlite-wal'];
  for (const file of files) {
    try { const data = readFileSync(join(dir, file)).toString(); assert.ok(!data.includes(config.cookie)); assert.ok(!data.includes(config.botToken)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
});

test('conditional config saves refuse stale revisions from another database connection', t => {
  const { store, dir } = fixture(t);
  const other = new Store(dir);
  try {
    const revision = store.getMeta('config');
    other.saveConfig({ ...other.getConfig(), interval: 180 });
    assert.equal(store.saveConfig({ ...config, nsProxy: 'socks5://127.0.0.1:1080' }, revision), false);
    assert.equal(store.getConfig().interval, 180);
    assert.equal(store.getConfig().nsProxy, '');
    assert.ok(store.saveConfig({ ...store.getConfig(), interval: 120 }, store.getMeta('config')));
    assert.equal(other.getConfig().interval, 120);
  } finally { other.close(); }
});

test('Telegram and Cookie edits preserve pending messages; changing account ID rebuilds baseline', t => {
  const { store } = fixture(t);
  store.ingest(normalizeMessages({ success: true, msgArray: [row(1)] }, '42'));
  store.saveConfig({ ...config, chatId: '99999' });
  assert.equal(store.ingest(normalizeMessages({ success: true, msgArray: [row(2)] }, '42')), 1);
  store.saveConfig({ ...config, cookie: 'session=another' });
  assert.equal(store.ingest(normalizeMessages({ success: true, msgArray: [row(3)] }, '42')), 1);
  assert.equal(store.pending().length, 2);
  store.saveConfig({ ...config, userId: '88' });
  assert.equal(store.ingest(normalizeMessages({ success: true, msgArray: [row(4, { receiver_id: 88 })] }, '88')), 0);
  assert.equal(store.pending().length, 0);
});

test('failed Telegram delivery remains queued and is retried after restart', async t => {
  const { store } = fixture(t);
  let items = [row(1)]; let fail = true; let sent = 0; let now = 100000;
  const monitor = new Monitor(store, { fetchMessages: async () => normalizeMessages({ success: true, msgArray: items }, '42'), send: async () => { if (fail) throw new Error('network'); sent++; }, now: () => now });
  await monitor.tick();
  items = [row(2)];
  now += config.interval * 1000;
  await monitor.tick();
  assert.equal(store.stats().pending, 1);
  assert.equal(sent, 0);
  now += 3600000; fail = false;
  const restarted = new Monitor(store, { fetchMessages: async () => [], send: async () => { sent++; }, now: () => now });
  await restarted.tick();
  assert.equal(store.stats().pending, 0);
  assert.equal(store.stats().sent, 1);
  assert.equal(sent, 1);
});

test('disabled monitoring sends nothing, and overlapping checks do not double-send', async t => {
  const { store } = fixture(t);
  let calls = 0;
  store.saveConfig({ ...config, enabled: false });
  const monitor = new Monitor(store, { fetchMessages: async () => { calls++; return []; }, send: async () => {}, now: () => Date.now() });
  await monitor.tick(); assert.equal(calls, 0);
  store.saveConfig(config);
  await Promise.all([monitor.tick(), monitor.tick()]);
  assert.equal(calls, 1);
});

test('invalid credential state sends only one warning until recovery', async t => {
  const { store } = fixture(t);
  let warnings = 0;
  const monitor = new Monitor(store, { fetchMessages: async () => { throw new NodeSeekError('auth', '登录失效'); }, send: async () => { warnings++; }, now: () => Date.now() });
  await monitor.tick(); await monitor.tick();
  assert.equal(warnings, 1);
  assert.equal(store.stats().sourceState, 'auth');
});
