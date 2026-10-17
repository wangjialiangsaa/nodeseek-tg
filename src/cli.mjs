import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { validateConfig } from './config.mjs';
import { createTerminalIO } from './terminal.mjs';
import { fetchMessages } from './nodeseek.mjs';
import { sendTelegram } from './telegram.mjs';
import { createTransport } from './transport.mjs';
import { Monitor } from './monitor.mjs';
import { loginNodeSeek, createInboxSource, verifyProxySession } from './browser.mjs';

export async function configureProxy(store, io, { verify = verifyProxySession, request } = {}) {
  const revision = store.getMeta('config');
  const previous = store.getConfig();
  if (!previous.userId || !previous.cookie) throw new Error('请先通过 config 完成论坛账号配置和登录');
  io.log('填写论坛 SOCKS5 链接，例如 socks5://用户名:密码@主机:端口；也支持 HTTP(S)。输入隐藏，回车保留已有代理，- 改为直连。');
  io.log('将通过新出口检查已有登录会话与私信接口；出口能直接访问时无需再次人工验证，论坛仍可能要求验证。');
  const value = await io.ask('NodeSeek 代理链接', { secret: true, proxy: true, hasValue: !!previous.nsProxy });
  if (!value.trim()) { io.log('未修改论坛代理。'); return; }
  const next = validateConfig(value.trim() === '-' ? { clearNsProxy: true } : { nsProxy: value }, previous);
  if (next.nsProxy === previous.nsProxy) { io.log('论坛代理未变化，无需重复检查。'); return; }
  io.log('正在测试新出口；测试完成前保留原配置，不发送 Telegram 测试消息。');
  if (io.signal?.aborted) throw new Error('代理配置已取消，原配置未改变');
  let verified;
  try { verified = await verify(next, request, { signal: io.signal }); }
  catch {
    if (io.signal?.aborted) throw new Error('代理配置已取消，原配置未改变');
    throw new Error('新出口未通过登录与私信检查，原配置已保留。请检查代理；如论坛要求验证，请在 config 向导填写该代理并完成登录验证。');
  }
  if (io.signal?.aborted) throw new Error('代理配置已取消，原配置未改变');
  if (!store.saveConfig({ ...next, ...verified }, revision)) throw new Error('配置已被其他进程更改，未覆盖新配置，请重新操作');
  store.log('info', '论坛代理已验证并保存，复用已有登录会话');
  io.log('论坛代理验证成功并已加密保存；登录和私信检查将使用该出口，检查间隔保持不变。');
}

export async function configure(store, io, { login = loginNodeSeek } = {}) {
  const previous = store.getConfig(); const input = {};
  io.log('\nNodeSeek → Telegram SSH 配置向导');
  io.log('回车保留已有配置；敏感输入不会回显；Ctrl+C 取消且不保存。');
  input.botToken = await io.ask('Telegram Bot Token', { secret: true, hasValue: !!previous.botToken });
  input.chatId = (await io.ask('主人 Chat ID', { defaultValue: previous.chatId })) || previous.chatId;
  input.userId = (await io.ask('我的 NodeSeek 数字用户 ID（个人主页 /space/ 后的数字）', { defaultValue: previous.userId })) || previous.userId;
  const method = (await io.ask('登录方式：1 账号密码（推荐） / 2 Cookie', { defaultValue: previous.userId ? (previous.authMode === 'password' ? '1' : '2') : '1' })).trim();
  if (method && !['1', '2'].includes(method)) throw new Error('登录方式请输入 1 或 2');
  input.authMode = (method || (previous.userId && previous.authMode !== 'password' ? '2' : '1')) === '1' ? 'password' : 'cookie';
  if (input.authMode === 'password') {
    input.username = (await io.ask('NodeSeek 账号', { defaultValue: previous.username })) || previous.username;
    input.password = await io.ask('NodeSeek 密码', { secret: true, hasValue: !!previous.password });
    io.log('账号密码在 SSH 填写；如需人机验证，通过临时浏览器手动完成。');
  } else {
    input.cookie = await io.ask('NodeSeek Cookie', { secret: true, hasValue: !!previous.cookie });
    input.userAgent = (await io.ask('浏览器 User-Agent', { defaultValue: previous.userAgent })) || previous.userAgent;
  }
  const interval = await io.ask('检查间隔，最短 30 秒', { defaultValue: String(previous.interval) });
  input.interval = interval.trim() ? Number(interval) : previous.interval;
  input.nsProxy = await io.ask('NodeSeek 代理（可选 HTTP(S) / SOCKS5）', { secret: true, proxy: true, hasValue: !!previous.nsProxy });
  input.tgProxy = await io.ask('Telegram 代理（可选 HTTP(S) / SOCKS5）', { secret: true, proxy: true, hasValue: !!previous.tgProxy });
  for (const key of ['nsProxy', 'tgProxy']) if (input[key].trim() === '-') { input[key] = ''; input[`clear${key[0].toUpperCase()}${key.slice(1)}`] = true; }
  const defaultEnabled = previous.userId ? previous.enabled : true;
  const enabled = (await io.ask('开启监控？y 开启 / n 暂停', { defaultValue: defaultEnabled ? 'y' : 'n' })).trim().toLowerCase();
  if (enabled && !['y', 'yes', '是', 'n', 'no', '否'].includes(enabled)) throw new Error('监控开关请输入 y 或 n');
  input.enabled = enabled ? ['y', 'yes', '是'].includes(enabled) : defaultEnabled;
  let next = validateConfig(input, previous);
  if (previous.userId && previous.userId !== next.userId && store.stats().pending) throw new Error('旧账号仍有待发消息，请先发送完毕再更换论坛用户 ID');
  if (next.authMode === 'password') {
    if (!next.username || !next.password) throw new Error('请填写 NodeSeek 账号和密码');
    const changed = previous.authMode !== 'password' || next.username !== previous.username || next.password !== previous.password || next.userId !== previous.userId || next.nsProxy !== previous.nsProxy;
    if (changed || !next.browserState) next = { ...next, ...await login(next, io) };
  } else { next.username = ''; next.password = ''; next.browserState = null; }
  if (io.signal?.aborted) throw new Error('配置已取消，原配置未改变');
  store.saveConfig(next);
  store.setMeta('tgNextAttempt', '0');
  store.log('info', next.enabled ? 'SSH 配置已保存，监控已开启' : 'SSH 配置已保存，监控已暂停');
  io.log(`配置已加密保存。监控：${next.enabled ? '开启' : '暂停'}；检查间隔：${next.interval} 秒。`);
}

export async function runCommand(command, { store, io = { log: console.log }, fetchInbox = fetchMessages, sendMessage = sendTelegram, login = loginNodeSeek, credentials, verifyProxy = verifyProxySession, request }) {
  if (command === 'configure' || command === 'config') return configure(store, io, { login });
  if (command === 'proxy') return configureProxy(store, io, { verify: verifyProxy, request });
  let config = store.getConfig();
  if (command === 'login') {
    if (credentials) {
      if (typeof credentials.username !== 'string' || !credentials.username || typeof credentials.password !== 'string' || !credentials.password) throw new Error('标准输入必须提供账号和密码');
      config = validateConfig({ authMode: 'password', username: credentials.username, password: credentials.password, ...('nsProxy' in credentials ? { nsProxy: credentials.nsProxy } : {}) }, config);
    }
    if (config.authMode !== 'password') throw new Error('请先执行 config，选择账号密码登录方式');
    const verified = await login(config, io);
    if (io.signal?.aborted) throw new Error('登录已取消，原配置未改变');
    store.saveConfig({ ...config, ...verified });
    store.setMeta('sourceState', 'idle'); store.setMeta('sourceDetail', '已重新登录，等待后台检查');
    store.log('info', 'NodeSeek 浏览器登录会话已加密保存');
    io.log('登录会话已加密保存，关闭临时验证入口。'); return;
  }
  if (command === 'status') {
    const stats = store.stats();
    const states = { idle: '等待首次检查', ok: '连接正常', auth: '登录已失效', blocked: '论坛验证或限流', network: '网络连接失败', format: '接口格式变化' };
    io.log(`登录方式：${config.authMode === 'password' ? '账号密码 + 浏览器会话' : 'Cookie'}${config.username ? `；账号：${config.username}` : ''}\n论坛密码：${config.password ? '已加密保存' : '未设置'}`);
    io.log(`监控：${config.enabled ? '开启' : '暂停'}\nNodeSeek 用户 ID：${config.userId || '未设置'}\n主人 Chat ID：${config.chatId || '未设置'}\n检查间隔：${config.interval} 秒\nCookie：${config.cookie ? '已加密保存' : '未设置'}\nBot Token：${config.botToken ? '已加密保存' : '未设置'}\nNodeSeek 代理：${config.nsProxy ? '已设置' : '未设置'}\nTelegram 代理：${config.tgProxy ? '已设置' : '未设置'}\n论坛状态：${states[stats.sourceState] || stats.sourceState}\n最后检查：${stats.lastCheck || '尚未检查'}\n待发送：${stats.pending}；累计发送：${stats.sent}`);
    if (stats.detail) io.log(stats.detail);
    if (store.getMeta('tgError')) io.log(store.getMeta('tgError'));
    return;
  }
  if (command === 'test-nodeseek') {
    if (!config.cookie || !config.userId || !config.userAgent) throw new Error('请先执行 config 完成登录与用户 ID 配置');
    const messages = await fetchInbox(config);
    io.log(`NodeSeek 连接成功，当前列表有 ${messages.length} 条收到的会话最新消息；未更改基线。`); return;
  }
  if (command === 'test-telegram') {
    if (!config.botToken || !config.chatId) throw new Error('请先执行 config 填写 Bot Token 和主人 Chat ID');
    await sendMessage(config, '✅ NodeSeek SSH 转发器测试成功。新私信将发送到这里。');
    io.log('测试消息已发送，请查看 Telegram。'); return;
  }
  if (command === 'check') {
    if (!config.enabled) throw new Error('监控已暂停，请先执行 config 开启监控');
    await new Monitor(store, { fetchMessages: fetchInbox, send: sendMessage }).tick(true);
    io.log(store.stats().detail || '检查完成'); return;
  }
  throw new Error('支持的命令：config、proxy、login、status、test-nodeseek、test-telegram、check');
}

async function main() {
  const command = process.argv[2] || 'status';
  let io; let store; let transport; let inbox;
  try {
    const stdinLogin = command === 'login' && process.argv.includes('--stdin');
    io = ['config', 'configure', 'proxy'].includes(command) || (command === 'login' && !stdinLogin) ? createTerminalIO() : { log: console.log };
    if (io.ask) io.confirmLogin = () => io.ask('浏览器确认已登录后，回到此 SSH 终端按回车继续检查');
    else if (stdinLogin) io.confirmLogin = signal => new Promise((resolve, reject) => {
      const cleanup = () => { process.removeListener('SIGUSR1', complete); signal.removeEventListener('abort', abort); };
      const complete = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error('登录已取消或超时，原配置未改变')); };
      process.once('SIGUSR1', complete); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else io.log('已断开自动化连接。浏览器登录完成后，由 SSH 管理员向本次登录进程发送 SIGUSR1 才开始检查。');
    });
    store = new Store(resolve(process.env.DATA_DIR || './data'));
    transport = createTransport();
    inbox = createInboxSource(store, transport.request, { persist: command === 'check' });
    let credentials;
    if (stdinLogin) {
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 16000) throw new Error('标准输入过长'); }
      try { credentials = JSON.parse(input); } catch { throw new Error('标准输入必须是账号密码 JSON'); }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('标准输入必须是账号密码 JSON 对象');
    }
    const controller = new AbortController();
    if (command === 'login' || command === 'proxy') { process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort()); io.signal = io.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal; }
    await runCommand(command, { store, io, credentials, request: transport.request, fetchInbox: c => inbox.fetch(c), sendMessage: (c, text) => sendTelegram(c, text, transport.request) });
  } catch (error) { console.error(`错误：${error.message}`); process.exitCode = 1; }
  finally { io?.close?.(); await inbox?.close(); await transport?.close(); store?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
