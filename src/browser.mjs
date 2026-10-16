import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { fetchMessages, NodeSeekError } from './nodeseek.mjs';
import { openProxy } from './proxy.mjs';

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

export async function openBrowser(config, { desktop = false } = {}) {
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
    upstream = await openProxy(config.nsProxy);
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

export async function loginNodeSeek(config, io = { log: console.log }) {
  if (!config.username || !config.password) throw new Error('请先在 SSH 配置中填写 NodeSeek 账号和密码');
  // A new sign-in must not inherit another account's session.
  const session = await openBrowser({ ...config, browserState: null }, { desktop: true });
  const deadline = Date.now() + 15 * 60 * 1000;
  let succeeded = false; let filled = false; let rejected = false;
  session.page.on('response', async response => {
    const url = new URL(response.url());
    if (url.protocol !== 'https:' || !isForum(url.hostname) || url.pathname.toLowerCase() !== '/api/account/signin') return;
    try {
      const result = await response.json();
      if (result.success === true && result.need2FA !== true) succeeded = true;
      else if (result.need2FA === true) io.log('此账号需要二次验证，请在论坛页面完成。');
      else rejected = true;
    } catch { rejected = true; }
  });
  io.log('浏览器验证已启动（15 分钟内完成）。配置仍在 SSH 填写。');
  io.log('在你电脑另一个终端建立 SSH 隧道：ssh -N -L 16080:127.0.0.1:6080 root@服务器IP');
  io.log('然后打开 http://127.0.0.1:16080/vnc.html?autoconnect=true&resize=scale');
  io.log(`本次临时桌面密码：${session.desktopPassword}（仅用于此验证窗口）`);
  io.log('请手动完成 Cloudflare / 人机验证，再点击论坛登录按钮。账号密码会自动填入。');
  io.log('验证入口只应通过 SSH 隧道访问；不要把 6080 端口开放到公网。');
  try {
    await session.page.goto(`${origin}/signIn.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    while (Date.now() < deadline) {
      if (io.signal?.aborted) throw new Error('登录已取消，原配置未改变');
      if (session.page.isClosed()) throw new Error('登录浏览器已关闭，原配置未改变');
      if (!filled) {
        if (await fillLoginFields(session.page, config)) {
          filled = true;
          io.log('账号密码已填入，请完成页面验证并点击登录。');
        }
      }
      if (rejected) { rejected = false; io.log('论坛尚未接受登录，请检查账号密码和页面验证后重试。'); }
      if (succeeded) {
        // Sign-in response can precede the browser's redirect and Set-Cookie processing.
        await delay(1500);
        await session.page.goto(`${origin}/notification#/message?mode=list`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await verifyBrowserIdentity(session, config);
        await browserMessages(session, config); // Do not save a session that cannot read the inbox.
        const browserState = filterState(await session.context.storageState());
        const cookie = cookieHeader(browserState);
        if (!cookie) throw new Error('登录后未获取到有效会话，原配置未改变');
        const userAgent = await session.page.evaluate(() => navigator.userAgent);
        if (io.signal?.aborted) throw new Error('登录已取消，原配置未改变');
        io.log('NodeSeek 登录与私信接口验证成功。');
        return { cookie, browserState, userAgent };
      }
      await delay(750);
    }
    throw new Error('登录验证超时，原配置未改变；请重新执行 login');
  } catch (error) {
    if (error instanceof NodeSeekError || /原配置未改变|超时/.test(error.message)) throw error;
    throw new Error('NodeSeek 登录未完成，请检查服务器网络并重新执行 login；原配置未改变');
  } finally { await session.close(); }
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
