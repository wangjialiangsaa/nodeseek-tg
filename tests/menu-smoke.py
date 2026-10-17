"""Exercise the actual Bash menu using a PTY and isolated action stubs."""
import os
import pty
import select
import signal
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='ns-menu-') as directory:
    target = Path(directory)
    (target / 'compose.yaml').write_text('services: {}\n')
    (target / 'install.sh').write_text('#!/usr/bin/env bash\nprintf "ACTION:%s\\n" "$1"\nif [[ "$1" == test-telegram ]]; then exit 1; fi\n')
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, INSTALL_DIR=directory)
        os.execvpe('bash', ['bash', 'install.sh'], env)
    output = b''
    cursor = 0
    finished = False
    deadline = time.monotonic() + 25

    def expect(text):
        global output, cursor
        marker = text.encode()
        while marker not in output[cursor:]:
            if time.monotonic() > deadline:
                raise AssertionError('Menu did not produce expected prompt: ' + text)
            if select.select([fd], [], [], 0.2)[0]:
                output += os.read(fd, 65536)
        cursor = output.index(marker, cursor) + len(marker)

    try:
        expect('12. 更换论坛 SOCKS5 代理')
        expect('请选择')
        os.write(fd, b'2\r')
        expect('ACTION:status')
        expect('请选择')
        os.write(fd, b'3\r')
        expect('ACTION:test-telegram')
        expect('请选择')
        os.write(fd, b'12\r')
        expect('ACTION:proxy')
        expect('请选择')
        os.write(fd, b'99\r')
        expect('无效选项')
        expect('请选择')
        os.write(fd, b'0\r')
        while True:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                finished = True
                assert os.waitstatus_to_exitcode(status) == 0
                break
            if time.monotonic() > deadline:
                raise AssertionError('Menu did not exit')
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    output += os.read(fd, 65536)
                except OSError:
                    pass
        print('SSH menu: selection, action failure recovery, invalid input and exit passed')
    finally:
        os.close(fd)
        if not finished:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass

# Run the real proxy action with a Docker stub; never touch a running service.
with tempfile.TemporaryDirectory(prefix='ns-proxy-menu-') as directory:
    target = Path(directory)
    (target / 'compose.yaml').write_text('services: {}\n')
    docker = target / 'docker'
    docker.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$4" >> "$NS_LOG"
case "$4" in
  ps) if [[ "$NS_RUNNING" == 1 ]]; then echo fixture; fi ;;
  stop) if [[ "$NS_MODE" == stop-fail ]]; then exit 1; fi ;;
  run)
    if [[ "$NS_MODE" == run-fail ]]; then exit 1; fi
    if [[ "$NS_MODE" == cancel ]]; then printf 'PROXY_TEST_WAITING\\n'; read -r answer </dev/tty; fi
    ;;
esac
''')
    docker.chmod(0o700)
    for running, mode in [(1, 'ok'), (0, 'ok'), (1, 'run-fail'), (1, 'stop-fail'), (1, 'cancel')]:
        log = target / f'{running}-{mode}.log'
        pid, fd = pty.fork()
        if pid == 0:
            env = dict(os.environ, INSTALL_DIR=directory, NS_RUNNING=str(running), NS_MODE=mode,
                       NS_LOG=str(log), PATH=directory + os.pathsep + os.environ['PATH'])
            os.execvpe('bash', ['bash', str(Path('install.sh').resolve()), 'proxy'], env)
        output = b''
        deadline = time.monotonic() + 15
        finished = False
        interrupted = False
        try:
            while True:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        output += os.read(fd, 65536)
                    except OSError:
                        pass
                if mode == 'cancel' and not interrupted and b'PROXY_TEST_WAITING' in output:
                    os.write(fd, b'\x03')
                    interrupted = True
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    finished = True
                    assert (os.waitstatus_to_exitcode(status) == 0) == (mode == 'ok'), (mode, output)
                    break
                assert time.monotonic() < deadline, (mode, output)
            expected = ['ps', 'stop'] + ([] if mode == 'stop-fail' else ['run']) + (['up'] if running else [])
            assert log.read_text().splitlines() == expected, (mode, log.read_text(), output)
        finally:
            if not finished:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(fd)
    print('Proxy action: running/stopped service, verification failure, stop failure and Ctrl+C recovery passed')
