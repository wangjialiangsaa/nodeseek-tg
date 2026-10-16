import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { fetchMessages, NodeSeekError } from './nodeseek.mjs';
import { openProxy } from './proxy.mjs';
import { createServer } from 'node:net';

const origin = 'https://www.nodeseek.com';
const isForum = domain => /^\.?(?:www\.)?nodeseek\.com$/.test(domain);

export function filterState(state) {
  return {
    cookies: state.cookies.filter(c => isForum(c.domain)),
    origins: state.origins.filter(o => { try { return new URL(o.origin).protocol === 'https:' && isForum(new URL(o.origin).hostname); } catch { return false; } })
  };
}

export function cookieHeader(state) {
  return state.cookies.filter(c => isForum(c.domain) && (c.expires <= 0 || c.expires > Date.now() / 1000))
    .map(c => `${c.name}=${c.value}`).join('; ');
}

function child(command, args, env) {
  const process = spawn(command, args, { stdio: 'ignore', env });
  process.on('error', () => {}); // Report a fixed error; never print browser output containing account data.
  return process;
}

export async function openBrowser(config, { desktop = false, manual = false } = {}) {
  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  if (!existsSync(executablePath)) throw new Error('缺少 Chromium，请更新 Docker 镜像后使用账号密码登录');
  const directory = mkdtempSync(join(tmpdir(), 'ns-browser-'));
  const displayNumber = 100 + Math.floor(Math.random() * 10000);
  const display = `:${displayNumber}`;
  const env = { ...process.env, DISPLAY: display, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory };
  const children = [];
  let browser; let upstream; let closed = false; let desktopPassword;
  async function close() {
    if (closed) return; closed = true;
    await browser?.close().catch(() => {});
    await upstream?.close().catch(() => {});
    for (const process of children.reverse()) if (process.exitCode == null) process.kill('SIGTERM');
    await Promise.all(children.map(p => p.exitCode != null ? undefined : Promise.race([new Promise(r => p.once('exit', r)), delay(2000)])));
    for (const process of children) if (process.exitCode == null) process.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    children.push(child('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'], env));
    for (let n = 0; n < 50 && !existsSync(`/tmp/.X11-unix/X${displayNumber}`); n++) await delay(100);
    if (!existsSync(`/tmp/.X11-unix/X${displayNumber}`)) throw new Error('无法启动浏览器显示服务，请检查镜像和内存');
    if (desktop) {
      desktopPassword = randomBytes(6).toString('base64url');
      // Standard VNC password-file format: DES using its fixed storage key.
      // Repeated-key 3DES is equivalent to DES and is available in Node's OpenSSL.
      // VNC's d3des reverses bits within each key byte; OpenSSL expects this order.
      const key = Buffer.from('e84ad660c4721ae0', 'hex');
      const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
      const passwordFile = join(directory, 'vnc-password');
      writeFileSync(passwordFile, Buffer.concat([cipher.update(Buffer.from(desktopPassword)), cipher.final()]), { mode: 0o600 });
      children.push(child('x11vnc', ['-display', display, '-localhost', '-rfbauth', passwordFile, '-forever', '-shared', '-rfbport', '5900', '-quiet'], env));
      children.push(child('websockify', ['--web=/usr/share/novnc', '0.0.0.0:6080', '127.0.0.1:5900'], env));
    }
    upstream = await openProxy(config.nsProxy, { anonymous: manual });
    if (manual) {
      const reservation = createServer();
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const endpoint = `http://127.0.0.1:${port}`;
      const args = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', `--user-data-dir=${join(directory, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`];
      if (upstream.url) args.push(`--proxy-server=${upstream.url}`);
      args.push('about:blank');
      const chrome = child(executablePath, args, env); children.push(chrome);
      let context; let page;
      async function targets() {
        if (closed || chrome.exitCode != null || chrome.signalCode != null) throw new Error('登录浏览器已关闭，原配置未改变');
        const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('无法读取登录浏览器状态');
        const list = await response.json(); return list.filter(target => target.type === 'page');
      }
      for (let n = 0; n < 100; n++) {
        try { await targets(); break; } catch { if (n === 99 || chrome.exitCode != null) throw new Error('无法启动普通登录浏览器'); await delay(200); }
      }
      async function connect() {
        if (browser?.isConnected()) return;
        browser = await chromium.connectOverCDP(endpoint, { timeout: 15000, noDefaults: true });
        context = browser.contexts()[0];
        page = context.pages().find(p => canInspectLogin(p.url())) || context.pages().find(p => { try { return isForum(new URL(p.url()).hostname); } catch { return false; } }) || context.pages()[0] || await context.newPage();
        page.setDefaultTimeout(15000);
      }
      // The connection is used to fill the form, then disconnected for the
      // human verification. No automation flags or fingerprint overrides.
      await connect();
      return { get browser() { return browser; }, get context() { return context; }, get page() { return page; }, close, desktopPassword, targets, connect, async disconnect() { await browser?.close(); browser = null; context = null; page = null; } };
    }
    const proxyUrl = upstream.url ? new URL(upstream.url) : null;
    const proxy = proxyUrl ? { server: `${proxyUrl.protocol}//${proxyUrl.host}`, username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) } : undefined;
    browser = await chromium.launch({ executablePath, headless: false, chromiumSandbox: false, env, proxy, args: ['--disable-dev-shm-usage', '--window-size=1280,900'], timeout: 45000 });
    const context = await browser.newContext({ storageState: config.browserState || undefined, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    return { browser, context, page, close, desktopPassword };
  } catch (error) {
    await close();
    if (/^无法启动/.test(error.message)) throw error;
    throw new Error('浏览器启动失败，请检查服务器内存、代理或更新 Docker 镜像');
  }
}

export async function verifyBrowserIdentity(session, config) {
  const identity = await session.page.evaluate(() => {
    const user = window.__config__?.user;
    if (!user) return null;
    return { id: String(user.id ?? user.member_id ?? '') };
  });
  if (!identity || !/^[1-9]\d*$/.test(identity.id)) throw new NodeSeekError('format', '论坛未返回可验证的当前用户身份，请更新程序；原配置未改变');
  if (identity.id !== config.userId) throw new NodeSeekError('auth', `实际登录账号 ID 为 ${identity.id}，与配置用户 ID 不一致，请修改配置后重试；原配置未改变`);
}

export async function fillLoginFields(page, config) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !isForum(url.hostname)) return false;
  const account = page.locator('#stacked-email, #login-account-name, input[name="username"], input[name="account"], input[type="email"]').first();
  const password = page.locator('#stacked-password, #login-account-password, input[type="password"]').first();
  if (!await account.isVisible() || !await password.isVisible()) return false;
  await account.fill(config.username); await password.fill(config.password);
  return true;
}

export async function browserMessages(session, config) {
  let reply;
  try {
    reply = await session.page.evaluate(async () => {
      const response = await fetch('/api/notification/message/list', { credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(25000) });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.type === 'opaqueredirect' ? 302 : response.status, data };
    });
  } catch { throw new NodeSeekError('network', '浏览器无法读取 NodeSeek，请检查网络或重新登录'); }
  return fetchMessages(config, async () => ({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => { if (reply.data == null) throw new Error('HTML'); return reply.data; } }));
}

export async function loginNodeSeek(config, io = { log: console.log }, { open = openBrowser } = {}) {
  if (!config.username || !config.password) throw new Error('请先在 SSH 配置中填写 NodeSeek 账号和密码');
  // A new sign-in must not inherit another account's session.
  const session = await open({ ...config, browserState: null }, { desktop: true, manual: true });
  const deadline = Date.now() + 60 * 60 * 1000;
  io.log('浏览器验证已启动（60 分钟内完成）。配置仍在 SSH 填写。');
  io.log('在你电脑另一个终端建立 SSH 隧道：ssh -N -L 16080:127.0.0.1:6080 root@服务器IP');
  io.log('然后打开 http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=scale');
  io.log(`本次临时桌面密码：${session.desktopPassword}（仅用于此验证窗口）`);
  io.log('请手动完成 Cloudflare / 人机验证，再点击论坛登录按钮；如有二次验证，也在页面中完成。');
  io.log('验证入口只应通过 SSH 隧道访问；不要把 6080 端口开放到公网。');
  try {
    await session.page.goto(`${origin}/signIn.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (await fillLoginFields(session.page, config)) io.log('账号密码已填入；现已断开自动化连接，请手动验证并登录。');
    else io.log('请在普通浏览器中完成页面验证，再填写账号密码并登录。');
    await session.disconnect();
    if (!io.confirmLogin) throw new Error('请通过交互式 SSH 登录，或使用受控登录完成信号；原配置未改变');
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(io.signal ? [io.signal] : [])]);
    if (signal.aborted) throw new Error('登录已取消或超时，原配置未改变');
    let onAbort;
    try {
      await Promise.race([io.confirmLogin(signal), new Promise((_, reject) => {
        onAbort = () => reject(new Error(signal.reason?.name === 'TimeoutError' ? '登录验证超时，原配置未改变' : '登录已取消，原配置未改变'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', onAbort); }
    if (signal.aborted) throw new Error('登录已取消或超时，原配置未改变');
    await session.connect();
    let selected;
    for (const page of session.context.pages().filter(p => canInspectLogin(p.url())).reverse()) {
      const identity = await page.evaluate(() => window.__config__?.user || null).catch(() => null);
      if (identity) { selected = { ...session, page }; break; }
    }
    if (!selected) throw new Error('尚未完成论坛登录，请确认已看到登录账号主页后重试；原配置未改变');
    await verifyBrowserIdentity(selected, config);
    await selected.page.goto(`${origin}/notification#/message?mode=list`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await verifyBrowserIdentity(selected, config);
    await browserMessages(selected, config); // Do not save a session that cannot read the inbox.
    const browserState = filterState(await selected.context.storageState());
    const cookie = cookieHeader(browserState);
    if (!cookie) throw new Error('登录后未获取到有效会话，原配置未改变');
    const userAgent = await selected.page.evaluate(() => navigator.userAgent);
    if (io.signal?.aborted) throw new Error('登录已取消，原配置未改变');
    io.log('NodeSeek 登录与私信接口验证成功。');
    return { cookie, browserState, userAgent };
  } catch (error) {
    if (error instanceof NodeSeekError || /原配置未改变|超时/.test(error.message)) throw error;
    throw new Error('NodeSeek 登录未完成，请检查服务器网络并重新执行 login；原配置未改变');
  } finally { await session.close(); }
}

export function canInspectLogin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isForum(url.hostname) && ![...url.searchParams.keys()].some(key => key.startsWith('__cf_chl')) && ['/', '/index.html', '/notification', '/notification/'].includes(url.pathname);
  } catch { return false; }
}

export function createInboxSource(store, request, { persist = true, open = openBrowser } = {}) {
  let session; let key = ''; let sessionRevision = '';
  async function invalidate() { await session?.close(); session = null; key = ''; sessionRevision = ''; }
  return {
    async fetch(config) {
      const revision = store.getMeta('config');
      if (config.authMode !== 'password') {
        await invalidate();
        return fetchMessages(config, request);
      }
      if (!config.browserState) throw new NodeSeekError('auth', '请执行 SSH 菜单 11 完成账号登录');
      const nextKey = JSON.stringify([config.userId, config.username, config.nsProxy]);
      if (!session || key !== nextKey || sessionRevision !== revision || !session.browser.isConnected()) {
        await invalidate();
        session = await open(config); key = nextKey; sessionRevision = revision;
        try { await session.page.goto(`${origin}/notification#/message?mode=list`, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        catch { await session.close(); session = null; throw new NodeSeekError('network', '浏览器无法打开 NodeSeek'); }
      }
      const result = await browserMessages(session, config);
      const browserState = filterState(await session.context.storageState());
      const updated = persist ? store.updateSession(revision, { browserState, cookie: cookieHeader(browserState) }) : store.getMeta('config') === revision ? revision : false;
      if (!updated) {
        await invalidate();
        throw new NodeSeekError('network', '配置已变更，已关闭旧浏览器，将使用最新配置重试');
      }
      sessionRevision = updated;
      return result;
    },
    close: invalidate
  };
}
