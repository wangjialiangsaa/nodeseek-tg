"""Exercise real terminal echo suppression and Ctrl+C via a Linux PTY."""
import os
import pty
import select
import sys
import tempfile
import time

command = sys.argv[1:] or ['node', 'src/cli.mjs', 'config']
if command and command[0] == '--':
    command = command[1:]


def interact(answers, cancel=False):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)
    transcript = b''
    cursor = 0
    deadline = time.monotonic() + 150
    finished = False
    try:
        for label, answer in answers:
            marker = label.encode()
            while marker not in transcript[cursor:]:
                if time.monotonic() > deadline:
                    raise AssertionError('Terminal prompt timed out: ' + label)
                if select.select([fd], [], [], 1)[0]:
                    transcript += os.read(fd, 65536)
            cursor = transcript.index(marker, cursor) + len(marker)
            os.write(fd, b'\x03' if cancel else answer.encode() + b'\r')
        while True:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                finished = True
                break
            if time.monotonic() > deadline:
                raise AssertionError('Terminal process did not exit')
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    transcript += os.read(fd, 65536)
                except OSError:
                    pass
        return os.waitstatus_to_exitcode(status), transcript.decode(errors='replace')
    finally:
        os.close(fd)
        if not finished:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass


with tempfile.TemporaryDirectory(prefix='ns-terminal-') as directory:
    os.environ.setdefault('DATA_DIR', directory)
    values = [
        ('Telegram Bot Token', '123456:CLI-secret-token'),
        ('主人 Chat ID', '98765'),
        ('我的 NodeSeek 数字用户 ID', '42'),
        ('登录方式', '2'),
        ('NodeSeek Cookie', 'session=CLI-secret-cookie'),
        ('浏览器 User-Agent', 'Mozilla/5.0 PTY test'),
        ('检查间隔', '60'),
        ('NodeSeek 代理', ''),
        ('Telegram 代理', ''),
        ('开启监控？', 'n'),
    ]
    code, output = interact(values)
    assert code == 0, 'Configuration process failed'
    assert '配置已加密保存' in output
    assert 'CLI-secret-token' not in output, 'Bot Token was echoed'
    assert 'CLI-secret-cookie' not in output, 'Cookie was echoed'
    code, output = interact([('Telegram Bot Token', '')], cancel=True)
    assert code != 0, 'Ctrl+C must cancel configuration'
    assert '原配置未改变' in output
    print('PTY configuration, hidden credentials and Ctrl+C passed')
