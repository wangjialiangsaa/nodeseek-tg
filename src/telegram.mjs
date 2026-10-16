export class TelegramError extends Error {
  constructor(message, retryAfter = 0) { super(message); this.retryAfter = retryAfter; }
}

export async function sendTelegram(config, text, request = globalThis.fetch) {
  let response;
  try {
    response = await request(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ chat_id: config.chatId, text: text.slice(0, 3900), link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(20000), proxy: config.tgProxy
    });
  } catch { throw new TelegramError('无法连接 Telegram，请检查网络或代理'); }
  let data;
  try { data = await response.json(); } catch { throw new TelegramError('Telegram 返回了异常响应'); }
  if (!response.ok || !data.ok) {
    const code = data.error_code || response.status;
    const detail = code === 401 || code === 404 ? 'Bot Token 无效' : code === 403 ? '用户已屏蔽机器人，请解除并发送 /start' : code === 400 ? 'Chat ID 无效或尚未向机器人发送 /start' : 'Telegram 请求失败';
    throw new TelegramError(`${detail}（${code}）`, Math.min(86400, Math.max(0, Number(data.parameters?.retry_after) || 0)));
  }
  return data.result?.message_id;
}
