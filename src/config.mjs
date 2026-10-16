import { defaults } from './store.mjs';

export function validateConfig(input, previous = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  const config = { ...previous };
  const strings = ['userId', 'cookie', 'botToken', 'chatId', 'userAgent', 'nsProxy', 'tgProxy', 'username', 'password', 'authMode'];
  const secrets = new Set(['cookie', 'botToken', 'nsProxy', 'tgProxy', 'password']);
  for (const key of strings) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string') throw new Error(`${key} 必须是文本`);
    const value = key === 'password' ? input[key] : input[key].trim();
    if (/[\r\n\0]/.test(value)) throw new Error('凭据、代理和请求头不能包含换行或空字符');
    if (value.length > (key === 'cookie' ? 16000 : 2048)) throw new Error(`${key} 内容过长`);
    if (!value && secrets.has(key)) continue;
    config[key] = value;
  }
  for (const key of ['nsProxy', 'tgProxy']) {
    if (input[`clear${key[0].toUpperCase()}${key.slice(1)}`] === true) config[key] = '';
    if (config[key]) {
      let url; try { url = new URL(config[key]); } catch { throw new Error('代理必须是有效 HTTP(S) 地址'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.search || url.pathname !== '/') throw new Error('代理只支持 HTTP(S)，格式 http://用户名:密码@IP:端口');
    }
  }
  if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new Error('监控开关格式错误'); config.enabled = input.enabled; }
  if ('interval' in input) {
    if (!Number.isInteger(input.interval) || input.interval < 30 || input.interval > 3600) throw new Error('检查间隔必须是 30–3600 秒之间的整数');
    config.interval = input.interval;
  }
  if (config.userId && !/^\d{1,20}$/.test(config.userId)) throw new Error('NodeSeek 用户 ID 必须是数字');
  if (config.chatId && !/^-?\d{1,20}$/.test(config.chatId)) throw new Error('主人 Chat ID 必须是数字');
  if (config.botToken && !/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(config.botToken)) throw new Error('Bot Token 格式错误');
  if (!['cookie', 'password'].includes(config.authMode)) throw new Error('登录方式必须是账号密码或 Cookie');
  const required = config.authMode === 'password' ? ['userId', 'username', 'password', 'botToken', 'chatId'] : ['userId', 'cookie', 'botToken', 'chatId', 'userAgent'];
  if (config.enabled && required.some(key => !config[key])) throw new Error(config.authMode === 'password' ? '请填写 NodeSeek 用户 ID、账号、密码、Bot Token 和主人 Chat ID 后开启监控' : '请填写 NodeSeek 用户 ID、Cookie、User-Agent、Bot Token 和主人 Chat ID 后开启监控');
  return config;
}
