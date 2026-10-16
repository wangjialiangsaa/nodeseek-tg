import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function healthy(directory, now = Date.now()) {
  try {
    const time = Number(readFileSync(join(directory, '.heartbeat'), 'utf8'));
    return Number.isFinite(time) && time > 0 && now - time >= 0 && now - time < 45000;
  } catch { return false; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = healthy(resolve(process.env.DATA_DIR || './data')) ? 0 : 1;
