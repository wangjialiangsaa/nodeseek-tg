import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const bash = process.env.BASH_BIN || 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
test('installer is valid Bash and rejects invalid input before invoking deployment', { skip: !bashAvailable && 'Bash is unavailable; Linux CI runs this check' }, () => {
  const syntax = spawnSync(bash, ['-n', 'install.sh'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync(bash, ['install.sh', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /install|安装/);
  const invalid = spawnSync(bash, ['install.sh', 'install', '--repo', 'bad/repo/extra'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /仓库/);
});

test('Docker excludes private data and uses persistent volume with a health check', () => {
  const ignored = readFileSync('.dockerignore', 'utf8');
  assert.match(ignored, /data/); assert.match(ignored, /\.env/);
  const compose = readFileSync('compose.yaml', 'utf8');
  assert.match(compose, /data:\/data/); assert.match(compose, /restart: unless-stopped/); assert.match(compose, /healthcheck:/);
  assert.ok(!readFileSync('install.sh', 'utf8').includes('--user root'), 'Backup must use the same unprivileged UID as the app to read 0600 data');
  assert.ok(readFileSync('public/.gitkeep', 'utf8').includes('Compatibility'), 'Original installed updater requires the public directory to exist');
});
