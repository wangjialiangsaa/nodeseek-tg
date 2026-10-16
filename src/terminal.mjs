import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createTerminalIO(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('配置向导需要交互式 SSH 终端。请执行 bash /opt/nodeseek-tg/install.sh config');
  let hidden = false;
  const sink = new Writable({ write(chunk, encoding, callback) { if (!hidden) output.write(chunk, encoding); callback(); } });
  sink.isTTY = true;
  Object.defineProperty(sink, 'columns', { get: () => output.columns || 80 });
  const controller = new AbortController();
  const rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  rl.on('SIGINT', () => controller.abort());
  rl.on('close', () => controller.abort());
  return {
    signal: controller.signal,
    log: text => output.write(`${text}\n`),
    async ask(label, { secret = false, defaultValue = '', hasValue = false, proxy = false } = {}) {
      const hint = secret ? `${hasValue ? '已保存，回车保留' : '输入隐藏'}${proxy ? '；- 清除' : ''}` : defaultValue ? `默认 ${defaultValue}` : '';
      const prompt = `${label}${hint ? `（${hint}）` : ''}：`;
      try {
        if (secret) { output.write(prompt); hidden = true; return await rl.question('', { signal: controller.signal }); }
        return await rl.question(prompt, { signal: controller.signal });
      } catch { throw new Error('配置已取消，原配置未改变'); }
      finally { if (secret) { hidden = false; output.write('\n'); } }
    },
    close() { rl.close(); sink.end(); }
  };
}
