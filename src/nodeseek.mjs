export class NodeSeekError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function plainText(value) {
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[x])
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
    .slice(0, 2800).trim();
}

export function normalizeMessages(data, userId) {
  if (data?.success === false && /登录|登陸|login|auth|session/i.test(String(data.message ?? data.msg ?? ''))) throw new NodeSeekError('auth', 'NodeSeek 登录已失效，请更新 Cookie');
  if (data?.success !== true || !Array.isArray(data.msgArray)) throw new NodeSeekError('format', 'NodeSeek 私信接口结构变化，未更新基线');
  const result = [];
  for (const item of data.msgArray) {
    if (!item || !/^\d+$/.test(String(item.max_id ?? '')) || item.receiver_id == null || item.sender_id == null) throw new NodeSeekError('format', 'NodeSeek 消息结构异常，未更新基线');
    if (String(item.receiver_id) !== String(userId) || String(item.sender_id) === String(userId)) continue;
    result.push({ id: String(item.max_id), sender: plainText(item.sender_name || `用户 ${item.sender_id}`).slice(0, 120), text: plainText(item.content) });
  }
  return result.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

export async function fetchMessages(config, request = globalThis.fetch) {
  let response;
  try {
    response = await request('https://www.nodeseek.com/api/notification/message/list', {
      headers: { Accept: 'application/json', Cookie: config.cookie, 'User-Agent': config.userAgent, Referer: 'https://www.nodeseek.com/notification' },
      redirect: 'manual', signal: AbortSignal.timeout(25000), proxy: config.nsProxy
    });
  } catch { throw new NodeSeekError('network', '无法连接 NodeSeek，请检查服务器网络或代理'); }
  if (response.status === 401 || response.status === 302) throw new NodeSeekError('auth', 'NodeSeek 登录已失效，请更新 Cookie');
  if (response.status === 403 || response.status === 429 || response.status === 503) throw new NodeSeekError('blocked', 'NodeSeek 验证或限流：检查 Cookie、User-Agent 和服务器出口 IP');
  if (!response.ok) throw new NodeSeekError('network', `NodeSeek 暂不可用（HTTP ${response.status}）`);
  let data;
  try { data = await response.json(); }
  catch { throw new NodeSeekError('blocked', 'NodeSeek 返回验证页面，请在浏览器完成验证后更新 Cookie'); }
  return normalizeMessages(data, config.userId);
}
