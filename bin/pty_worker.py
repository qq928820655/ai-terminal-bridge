#!/usr/bin/env python3
"""PTY worker: runs a shell under a pseudo terminal and multiplexes JSON frames.

stdin  <- newline delimited JSON control frames
stdout -> newline delimited JSON data frames

Control frames:
  {"t":"i","d":"<base64>"}          write bytes to the pty
  {"t":"r","c":<cols>,"r":<rows>}   resize the pty
  {"t":"k"}                         send SIGHUP to the child

Data frames:
  {"t":"o","d":"<base64>"}          bytes read from the pty
  {"t":"x","c":<exit code>}         child exited
  {"t":"e","m":"<message>"}         worker level error
"""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    shell = os.environ.get("AITB_SHELL") or "/bin/bash"
    cwd = os.environ.get("AITB_CWD") or os.getcwd()
    cols = int(os.environ.get("AITB_COLS") or 120)
    rows = int(os.environ.get("AITB_ROWS") or 32)

    if not os.path.isdir(cwd):
        cwd = os.path.expanduser("~")
    try:
        os.chdir(cwd)
    except OSError:
        pass

    env = dict(os.environ)
    env.setdefault("TERM", "xterm-256color")
    env["COLORTERM"] = "truecolor"

    pid, fd = pty.fork()
    if pid == 0:
        try:
            argv_raw = os.environ.get("AITB_ARGV")
            if argv_raw:
                argv = json.loads(argv_raw)
                os.execvpe(argv[0], argv, env)
            os.execvpe(shell, [shell, "-i"], env)
        except Exception as exc:  # noqa: BLE001
            os.write(2, ("exec failed: %s\r\n" % exc).encode())
            os._exit(127)

    set_winsize(fd, rows, cols)

    stdin_fd = sys.stdin.fileno()
    pending = b""
    child_done = False
    exit_code = 0

    while True:
        try:
            rlist, _, _ = select.select([fd, stdin_fd], [], [], 1.0)
        except InterruptedError:
            continue
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            break

        if stdin_fd in rlist:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
                stdin_fd = -1
            else:
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        frame = json.loads(line.decode("utf-8", "replace"))
                    except ValueError:
                        emit({"t": "e", "m": "bad json frame"})
                        continue
                    kind = frame.get("t")
                    if kind == "i":
                        try:
                            os.write(fd, base64.b64decode(frame.get("d") or ""))
                        except OSError:
                            pass
                    elif kind == "r":
                        set_winsize(fd, int(frame.get("r") or rows), int(frame.get("c") or cols))
                    elif kind == "k":
                        try:
                            os.kill(pid, signal.SIGHUP)
                        except OSError:
                            pass

        if fd in rlist:
            try:
                data = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    data = b""
                else:
                    data = b""
            if not data:
                child_done = True
            else:
                emit({"t": "o", "d": base64.b64encode(data).decode("ascii")})

        if child_done:
            try:
                _, status = os.waitpid(pid, 0)
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)
            except OSError:
                pass
            break

    emit({"t": "x", "c": exit_code})
    try:
        os.close(fd)
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
