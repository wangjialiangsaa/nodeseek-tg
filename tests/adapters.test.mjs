import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateConfig } from '../src/config.mjs';
import { fetchMessages } from '../src/nodeseek.mjs';
import { sendTelegram } from '../src/telegram.mjs';

test('configuration rejects too-fast polling, header injection and invalid proxies', () => {
  assert.throws(() => validateConfig({ interval: 1 }), /30/);
  assert.throws(() => validateConfig({ cookie: 'a=b\r\nx-evil: 1' }), /换行/);
  assert.throws(() => validateConfig({ nsProxy: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => validateConfig({ enabled: true }), /填写/);
});
test('real HTTP adapters use cookies and plain text; retry errors redact credentials', async t => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ headers: req.headers, body }); res.setHeader('Content-Type', 'application/json');
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
