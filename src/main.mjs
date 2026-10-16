import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Store } from './store.mjs';
import { Monitor } from './monitor.mjs';
import { createApp, setPassword } from './server.mjs';
import { fetchMessages } from './nodeseek.mjs';
import { sendTelegram } from './telegram.mjs';
import { createTransport } from './transport.mjs';

const dataDir = resolve(process.env.DATA_DIR || './data');
const store = new Store(dataDir);
if (process.argv.includes('--reset-password')) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) { console.error('请通过 ADMIN_PASSWORD 环境变量提供新密码（至少 12 位）'); process.exit(1); }
  await setPassword(store, password); store.close(); console.log('管理员密码已重置；请重启服务使现有会话退出。'); process.exit(0);
}
if (!store.getMeta('password')) {
  const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString('hex');
  await setPassword(store, password);
  if (!process.env.ADMIN_PASSWORD) console.log(`首次管理员密码：${password}\n请保存密码并在登录后修改。`);
}
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
const transport = createTransport();
const fetchInbox = config => fetchMessages(config, transport.request);
const sendMessage = (config, text) => sendTelegram(config, text, transport.request);
const monitor = new Monitor(store, { fetchMessages: fetchInbox, send: sendMessage });
const server = createApp({ store, monitor, fetchInbox, sendMessage, secureCookie: process.env.COOKIE_SECURE === 'true', publicUrl: process.env.PUBLIC_URL || '' });
server.listen(port, process.env.HOST || '0.0.0.0', () => { console.log(`NodeSeek TG 已启动，监听端口 ${port}`); monitor.start(); });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  const serverClosed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  await serverClosed;
  await monitor.stop(); await transport.close(); store.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请更换 PORT' : '服务监听失败，请检查监听地址和权限'); process.exitCode = 1; shutdown(); });
