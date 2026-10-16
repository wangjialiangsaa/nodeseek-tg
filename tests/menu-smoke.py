"""Exercise the actual Bash menu using a PTY and isolated action stubs."""
import os
import pty
import select
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
        expect('请选择')
        os.write(fd, b'2\r')
        expect('ACTION:status')
        expect('请选择')
        os.write(fd, b'3\r')
        expect('ACTION:test-telegram')
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
