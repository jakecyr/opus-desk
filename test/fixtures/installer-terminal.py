"""Exercise curl-pipe-style setup with a real controlling terminal, offline."""

import os
import pty
import select
import sys
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", 'cat "$FIXTURE_SCRIPT" | bash'])

prompts = [
    (b"Set up GitHub, install/update your agent, and install Opus Desk? [Y/n]", b"\n"),
    (b"Choice [1]:", b"2\n"),
    (b"Add Opus Desk to PATH", b"\n"),
    (b"Parent folder containing your Git repositories", os.fsencode(os.environ["HOME"]) + b"\n"),
    (b"Start or restart Opus Desk now? [Y/n]", b"n\n"),
]
output = b""
answered = set()
deadline = time.monotonic() + 20
try:
    while time.monotonic() < deadline:
        if not select.select([terminal], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(terminal, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        for index, (prompt, answer) in enumerate(prompts):
            if index not in answered and prompt in output:
                os.write(terminal, answer)
                answered.add(index)
    else:
        os.kill(pid, 9)
        raise TimeoutError("Installer did not complete in its terminal")
finally:
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)

sys.exit(os.waitstatus_to_exitcode(status))
