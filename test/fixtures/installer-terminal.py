"""Exercise curl-pipe-style setup with a real controlling terminal, offline."""

import json
import os
import pty
import select
import signal
import sys
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", 'cat "$FIXTURE_SCRIPT" | bash'])

answers = {
    "Install Opus Desk?": [""],
    "Configure GitHub hostname?": [""],
    "Configure your projects folder?": [""],
    "Set up GitHub tools and authentication?": [""],
    "Choose and set up a coding agent?": [""],
    "Install missing GitHub tools": [""],
    "Configure Git to use GitHub CLI credentials?": [""],
    "Check GitHub OAuth scopes and offer refresh?": [""],
    "Refresh GitHub OAuth scopes now?": ["", "", ""],
    "Install codex using its official installer?": [""],
    "Install claude using its official installer?": [""],
    "Check codex login and offer its standard sign-in?": [""],
    "Check claude login and offer its standard sign-in?": [""],
    "standard sign-in now?": [""],
    "GitHub hostname [": [os.environ.get("FIXTURE_HOST", "")],
    "Authenticate GitHub CLI with": [os.environ.get("FIXTURE_AUTH_ANSWER", "y")],
    "Choice [1]:": ["2"],
    "Add Opus Desk to PATH": [""],
    "Parent folder containing your Git repositories": [os.environ["HOME"]],
    "Start or restart Opus Desk now?": ["n"],
    "Retry ": ["y"],
    "GitHub access is still incomplete.": ["y"],
}
answers.update(json.loads(os.environ.get("FIXTURE_ANSWERS", "{}")))
output = b""
pending = b""
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
        pending += chunk
        while True:
            matches = [
                (pending.find(os.fsencode(prompt)), prompt)
                for prompt in answers
                if os.fsencode(prompt) in pending
            ]
            if not matches:
                break
            offset, prompt = min(matches)
            pending = pending[offset + len(os.fsencode(prompt)):]
            choices = answers[prompt]
            if not choices:
                raise RuntimeError("No fixture answer left for " + prompt)
            answer = choices.pop(0)
            os.write(terminal, b"\x04" if answer is None else os.fsencode(answer) + b"\n")
    else:
        raise TimeoutError("Installer did not complete in its terminal")
finally:
    # Also reap the subprocess when a prompt expectation or deadline fails.
    if sys.exc_info()[0]:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)

sys.exit(os.waitstatus_to_exitcode(status))
