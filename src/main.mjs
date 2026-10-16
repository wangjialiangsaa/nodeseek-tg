import { resolve, join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { Store } from './store.mjs';
import { Monitor } from './monitor.mjs';
import { createInboxSource } from './browser.mjs';
import { sendTelegram } from './telegram.mjs';
import { createTransport } from './transport.mjs';

const dataDir = resolve(process.env.DATA_DIR || './data');
const store = new Store(dataDir);
const transport = createTransport();
const inbox = createInboxSource(store, transport.request);
const fetchInbox = config => inbox.fetch(config);
const sendMessage = (config, text) => sendTelegram(config, text, transport.request);
const monitor = new Monitor(store, { fetchMessages: fetchInbox, send: sendMessage });
const heartbeat = join(dataDir, '.heartbeat');
function beat() { writeFileSync(heartbeat, String(Date.now()), { mode: 0o600 }); }
beat();
const timer = setInterval(() => { try { beat(); } catch { console.error('写入运行心跳失败，请检查磁盘和数据目录权限'); process.exitCode = 1; shutdown(); } }, 10000);
monitor.start();
console.log('NodeSeek TG 后台监控已启动（SSH 配置模式，不开放网页端口）。');
if (!store.getConfig().cookie) console.log('尚未配置账号，请执行安装脚本的 config 命令。');
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(timer);
  await monitor.stop(); await inbox.close(); await transport.close(); store.close();
  rmSync(heartbeat, { force: true });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
