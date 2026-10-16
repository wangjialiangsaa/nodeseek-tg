import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { validateConfig } from './config.mjs';
import { fetchMessages } from './nodeseek.mjs';
import { sendTelegram } from './telegram.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 12 * 60 * 60 * 1000;

export async function setPassword(store, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('管理员密码长度应为 12–200 个字符');
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  store.setMeta('password', `${salt}:${hash.toString('hex')}`);
}

async function verifyPassword(store, password) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt, hex] = store.getMeta('password').split(':');
  if (!salt || !hex) return false;
  const hash = await scrypt(password, salt, 64);
  const stored = Buffer.from(hex, 'hex');
  return stored.length === hash.length && timingSafeEqual(stored, hash);
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function bodyJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'JSON 格式错误'); }
}

export function createApp({ store, monitor, fetchInbox = fetchMessages, sendMessage = sendTelegram, secureCookie = false, publicUrl = '' }) {
  const sessions = new Map(); const attempts = new Map();
  let editing = false; let lastManual = 0;
  const cookieValue = token => `ns_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 43200 : 0}${secureCookie ? '; Secure' : ''}`;
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  function prune() {
    const now = Date.now();
    for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
    for (const [key, item] of attempts) if (item.until < now) attempts.delete(key);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function json(status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
    try {
      prune();
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return json(200, { ok: true });
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        const data = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }); return res.end(data);
      }
      if (!path.startsWith('/api/')) throw new HttpError(404, '页面不存在');
      if (req.method !== 'GET') {
        if (req.headers['x-requested-with'] !== 'NodeSeek-TG') throw new HttpError(403, '请求来源验证失败');
        const origin = req.headers.origin;
        if (origin) {
          let valid = false;
          try { const u = new URL(origin); valid = publicUrl ? u.origin === new URL(publicUrl).origin : ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host; } catch {}
          if (!valid) throw new HttpError(403, '不允许跨站修改配置');
        }
      }
      const token = /(?:^|;\s*)ns_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const authenticated = !!token && sessions.has(token);
      if (path === '/api/session' && req.method === 'GET') return json(200, { authenticated });
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || { count: 0, until: Date.now() + 900000 };
        if (attempt.count >= 5 || attempts.size > 1000) throw new HttpError(429, '登录尝试过多，请 15 分钟后重试');
        attempt.count++; attempts.set(ip, attempt);
        const body = await bodyJson(req);
        if (!await verifyPassword(store, body?.password)) throw new HttpError(401, '管理员密码错误');
        attempts.delete(ip);
        const session = randomBytes(32).toString('hex');
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        sessions.set(session, Date.now() + SESSION_MS);
        res.setHeader('Set-Cookie', cookieValue(session)); return json(200, { ok: true });
      }
      if (!authenticated) throw new HttpError(401, '请先登录管理面板');
      if (path === '/api/logout' && req.method === 'POST') { sessions.delete(token); res.setHeader('Set-Cookie', cookieValue('')); return json(200, { ok: true }); }
      if (path === '/api/config' && req.method === 'GET') return json(200, store.publicConfig());
      if (path === '/api/status' && req.method === 'GET') return json(200, { ...store.stats(), enabled: store.getConfig().enabled, busy: monitor.busy, tgError: store.getMeta('tgError'), logs: store.logs() });
      if (path === '/api/password' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!await verifyPassword(store, input.currentPassword)) throw new HttpError(401, '原密码不正确');
        try { await setPassword(store, input.password); } catch (e) { throw new HttpError(400, e.message); }
        sessions.clear(); res.setHeader('Set-Cookie', cookieValue('')); return json(200, { ok: true });
      }
      if (path === '/api/config' && req.method === 'PUT') {
        const input = await bodyJson(req);
        if (editing) throw new HttpError(409, '配置正在保存，请稍后重试');
        let config;
        try { config = validateConfig(input, store.getConfig()); } catch (error) { throw new HttpError(400, error.message); }
        editing = true;
        try {
          await monitor.stop();
          const value = store.saveConfig(config); monitor.reset();
          store.setMeta('tgNextAttempt', '0');
          store.log('info', config.enabled ? '配置已保存，监控已开启' : '配置已保存，监控已暂停');
          return json(200, value);
        } finally { editing = false; monitor.start(); }
      }
      if (req.method === 'POST' && ['/api/test/nodeseek', '/api/test/telegram', '/api/check'].includes(path)) {
        if (editing || monitor.busy) throw new HttpError(409, '检查正在进行，请稍后再试');
        if (Date.now() - lastManual < 30000) throw new HttpError(429, '手动测试或检查请间隔至少 30 秒');
        lastManual = Date.now();
        const config = store.getConfig();
        if (path === '/api/test/nodeseek') {
          if (!config.cookie || !config.userId || !config.userAgent) throw new HttpError(400, '请先保存 NodeSeek Cookie、用户 ID 和 User-Agent');
          try { const messages = await fetchInbox(config); return json(200, { ok: true, message: `连接成功，当前列表有 ${messages.length} 条收到的会话最新消息；尚未更改基线` }); }
          catch (e) { throw new HttpError(502, e.message); }
        }
        if (path === '/api/test/telegram') {
          if (!config.botToken || !config.chatId) throw new HttpError(400, '请先保存 Bot Token 和主人 Chat ID');
          try { await sendMessage(config, '✅ NodeSeek 转发器测试成功。新私信将发送到这里。'); return json(200, { ok: true, message: '测试消息已发送，请查看 Telegram' }); }
          catch (e) { throw new HttpError(502, e.message); }
        }
        if (!config.enabled) throw new HttpError(400, '请先开启监控并保存配置');
        await monitor.tick(true); return json(200, { ok: true, message: store.stats().detail });
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '服务内部错误，请检查数据目录权限和磁盘空间' });
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
