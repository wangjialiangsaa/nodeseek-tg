import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';

export const defaults = { enabled: false, userId: '', cookie: '', botToken: '', chatId: '', interval: 60, userAgent: '', nsProxy: '', tgProxy: '' };

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = join(directory, '.secret_key');
    if (!existsSync(keyFile)) {
      if (existsSync(join(directory, 'state.sqlite'))) throw new Error('数据库存在但加密密钥缺失，请恢复 .secret_key');
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('加密密钥格式错误');
    this.db = new DatabaseSync(join(directory, 'state.sqlite'));
    chmodSync(join(directory, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL, kind TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL);`);
    this.closed = false;
    this.getConfig(); // Fail startup if the encryption key cannot decrypt existing data.
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value) {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
  getMeta(key, fallback = '') { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? fallback; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getConfig() { const raw = this.getMeta('config'); return raw ? { ...defaults, ...this.decrypt(raw) } : { ...defaults }; }
  saveConfig(config) {
    const previous = this.getConfig();
    const next = { ...defaults, ...config };
    return this.transaction(() => {
      if (previous.userId !== next.userId) {
        this.db.exec('DELETE FROM seen; DELETE FROM outbox WHERE sent=0;');
        this.setMeta('baseline', '0');
        this.setMeta('generation', randomUUID());
        this.setMeta('sourceState', 'idle');
      }
      this.setMeta('config', this.encrypt(next));
      return this.publicConfig();
    });
  }
  publicConfig() {
    const c = this.getConfig();
    const { cookie, botToken, nsProxy, tgProxy, ...visible } = c;
    return { ...visible, hasCookie: !!cookie, hasBotToken: !!botToken, hasNsProxy: !!nsProxy, hasTgProxy: !!tgProxy };
  }
  ingest(messages) {
    return this.transaction(() => {
      const baseline = this.getMeta('baseline') === '1';
      let added = 0;
      const insert = this.db.prepare('INSERT OR IGNORE INTO seen(id) VALUES(?)');
      for (const message of messages) {
        if (insert.run(message.id).changes && baseline) {
          this.enqueue(`message:${this.getMeta('generation')}:${message.id}`, `📩 NodeSeek 新私信\n来自：${message.sender}\n\n${message.text || '（无文本内容）'}\n\n打开私信：https://www.nodeseek.com/notification#/message?mode=list`, 'message');
          added++;
        }
      }
      this.setMeta('baseline', '1');
      if (!baseline) this.log('info', `基线已建立，跳过 ${messages.length} 条现有消息`);
      else if (added) this.log('info', `${added} 条新私信已加入发送队列`);
      return added;
    });
  }
  enqueue(key, text, kind = 'alert') {
    this.db.prepare('INSERT OR IGNORE INTO outbox(event_key,text,kind,created) VALUES(?,?,?,?)').run(key, text, kind, Date.now());
  }
  pending(now = Number.MAX_SAFE_INTEGER) { return this.db.prepare('SELECT * FROM outbox WHERE sent=0 AND due<=? ORDER BY id LIMIT 20').all(now); }
  markSent(id) { this.db.prepare('UPDATE outbox SET sent=1,text=\'\' WHERE id=?').run(id); }
  markRetry(id, due) { this.db.prepare('UPDATE outbox SET attempts=attempts+1,due=? WHERE id=?').run(due, id); }
  log(level, text) {
    this.db.prepare('INSERT INTO logs(time,level,text) VALUES(?,?,?)').run(Date.now(), level, text);
    this.db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 300)');
  }
  logs() { return this.db.prepare('SELECT time,level,text FROM logs ORDER BY id DESC LIMIT 60').all(); }
  stats() {
    return { pending: this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent=0').get().n,
      sent: this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE sent=1 AND kind='message'").get().n,
      baseline: this.getMeta('baseline') === '1', sourceState: this.getMeta('sourceState', 'idle'), lastCheck: this.getMeta('lastCheck'),
      detail: this.getMeta('sourceDetail'), nextCheck: Number(this.getMeta('nextCheck', '0')) };
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
