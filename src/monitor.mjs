import { randomUUID } from 'node:crypto';
import { fetchMessages } from './nodeseek.mjs';
import { sendTelegram } from './telegram.mjs';

export class Monitor {
  constructor(store, options = {}) {
    this.store = store; this.fetchMessages = options.fetchMessages ?? fetchMessages;
    this.send = options.send ?? sendTelegram; this.now = options.now ?? Date.now;
    this.busy = false; this.nextCheck = 0; this.failures = 0; this.timer = null;
  }
  reset() { this.nextCheck = 0; this.failures = 0; }
  async tick(force = false) {
    if (this.busy) return;
    const config = this.store.getConfig();
    if (!config.enabled || !config.cookie || !config.botToken || !config.chatId || !config.userId) return;
    this.busy = true;
    try {
      if (force || this.now() >= this.nextCheck) {
        this.store.setMeta('lastCheck', new Date(this.now()).toISOString());
        try {
          const messages = await this.fetchMessages(config);
          this.store.ingest(messages);
          this.failures = 0;
          this.store.setMeta('sourceState', 'ok'); this.store.setMeta('sourceDetail', 'NodeSeek 连接正常');
          this.nextCheck = this.now() + config.interval * 1000;
        } catch (error) {
          const code = ['auth', 'blocked', 'format', 'network'].includes(error.code) ? error.code : 'network';
          const text = code === 'auth' ? 'NodeSeek 登录失效，请在 SSH 菜单重新登录或更新 Cookie' : code === 'blocked' ? 'NodeSeek 验证或限流，请在 SSH 菜单重新登录并手动完成验证，或检查服务器 IP' : code === 'format' ? 'NodeSeek 接口格式变化，需要更新程序' : 'NodeSeek 连接失败，将自动重试';
          const changed = this.store.getMeta('sourceState') !== code;
          this.store.transaction(() => {
            this.store.setMeta('sourceState', code); this.store.setMeta('sourceDetail', text);
            if (changed) {
              this.store.log('warn', text);
              if (code !== 'network') this.store.enqueue(`alert:${randomUUID()}`, `⚠️ ${text}`);
            }
          });
          this.failures++;
          this.nextCheck = this.now() + Math.min(3600, Math.max(config.interval, code === 'auth' || code === 'blocked' ? 300 : 60) * 2 ** Math.min(this.failures - 1, 6)) * 1000;
        }
        this.store.setMeta('nextCheck', this.nextCheck);
      }
      if (this.now() < Number(this.store.getMeta('tgNextAttempt', '0'))) return;
      for (const item of this.store.pending(this.now())) {
        try {
          await this.send(config, item.text);
          this.store.markSent(item.id);
          this.store.log('info', item.kind === 'message' ? '一条私信已发送到 Telegram' : '状态提醒已发送到 Telegram');
          this.store.setMeta('tgError', '');
        } catch (error) {
          const delay = Math.max(Math.min(3600, 15 * 2 ** Math.min(item.attempts, 8)), error.retryAfter || 0) * 1000;
          this.store.markRetry(item.id, this.now() + delay);
          this.store.setMeta('tgNextAttempt', this.now() + delay);
          this.store.setMeta('tgError', 'Telegram 发送失败，已保留消息并安排重试');
          if (item.attempts === 0) this.store.log('warn', 'Telegram 发送失败，消息保留在队列中');
          break;
        }
      }
    } finally { this.busy = false; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => this.store.log('error', '后台检查异常，将在下一轮重试')), 1000);
    this.timer.unref();
    this.tick().catch(() => this.store.log('error', '后台检查异常，将在下一轮重试'));
  }
  async stop() {
    clearInterval(this.timer); this.timer = null;
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 50));
  }
}
