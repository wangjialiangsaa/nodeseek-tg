import { Server } from 'proxy-chain';

// Chromium cannot authenticate SOCKS proxies directly. Keep the adapter inside
// the container and let the upstream SOCKS proxy resolve destination names.
export async function openProxy(proxy, { anonymous = false } = {}) {
  if (!proxy) return { url: proxy, close: async () => {} };
  const upstream = new URL(proxy); const socks = ['socks5:', 'socks5h:'].includes(upstream.protocol);
  if (!socks && !anonymous) return { url: proxy, close: async () => {} };
  if (socks) upstream.protocol = 'socks5h:';
  upstream.hash = '';
  const server = new Server({ host: '127.0.0.1', port: 0, verbose: false, prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.href }) });
  try { await server.listen(); }
  catch { await server.close(true).catch(() => {}); throw new Error('无法启动本地代理'); }
  let closed = false;
  return { url: `http://127.0.0.1:${server.port}`, async close() { if (!closed) { closed = true; await server.close(true); } } };
}
