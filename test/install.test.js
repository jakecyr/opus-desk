import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../install.sh', import.meta.url));

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const stage = path.join(dir, 'stage');
  await fs.mkdir(bin);
  await fs.mkdir(stage);
  await fs.writeFile(
    path.join(stage, 'opus-desk'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_CALLS"\n',
    { mode: 0o755 },
  );
  const archive = path.join(dir, 'archive.tar.gz');
  await exec('tar', ['-czf', archive, '-C', stage, 'opus-desk']);
  const digest = createHash('sha256')
    .update(await fs.readFile(archive))
    .digest('hex');
  const commands = {
    curl: `#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o|--output) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
case "$url" in
  */releases/latest) printf 'https://github.com/jakecyr/opus-desk/releases/tag/v1.2.3' ;;
  */SHA256SUMS) printf '%s  opus-desk-darwin-arm64.tar.gz\\n%s  opus-desk-darwin-x64.tar.gz\\n%s  opus-desk-linux-x64.tar.gz\\n%s  opus-desk-linux-arm64.tar.gz\\n' "$FIXTURE_DIGEST" "$FIXTURE_DIGEST" "$FIXTURE_DIGEST" "$FIXTURE_DIGEST" > "$out" ;;
  *.tar.gz) cp "$FIXTURE_ARCHIVE" "$out" ;;
  *) exit 1 ;;
esac
`,
    gh: `#!/bin/sh
printf '%s\\n' "gh $*" >> "$FIXTURE_CALLS"
case "$1 $2" in
  'auth status') [ "$FIXTURE_AUTH" = 1 ] ;;
  'api --hostname') printf 'HTTP/2 200\\nx-oauth-scopes: %s\\n\\n{}\\n' "$FIXTURE_SCOPES" ;;
  '--version ') echo 'gh fixture' ;;
  *) exit 0 ;;
esac
`,
    codex: '#!/bin/sh\nprintf "%s\\n" "codex $*" >> "$FIXTURE_CALLS"\nexit 0\n',
    claude:
      '#!/bin/sh\nprintf "%s\\n" "claude $*" >> "$FIXTURE_CALLS"\nexit 0\n',
  };
  for (const [name, body] of Object.entries(commands))
    await fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: dir,
    PATH: `${bin}:${process.env.PATH}`,
    OPUSDESK_NONINTERACTIVE: '1',
    OPUSDESK_AGENT: 'codex',
    OPUSDESK_INSTALL_DIR: path.join(dir, 'install'),
    FIXTURE_ARCHIVE: archive,
    FIXTURE_DIGEST: digest,
    FIXTURE_CALLS: path.join(dir, 'calls'),
    FIXTURE_AUTH: '1',
    FIXTURE_SCOPES: 'repo, read:org, workflow, read:project',
    ...overrides,
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.OPUSDESK_START;
  delete env.OPUSDESK_PROJECTS_DIR;
  delete env.OPUSDESK_VERSION;
  return {
    dir,
    env,
    run: () => exec('bash', [script], { env, timeout: 15000 }),
    calls: () => fs.readFile(env.FIXTURE_CALLS, 'utf8'),
  };
}

test('installer verifies a release and configures the selected authenticated agent', async (t) => {
  const f = await fixture(t, { OPUSDESK_AGENT: 'claude' });
  const result = await f.run();
  assert.match(result.stdout, /Installed/);
  assert.equal(
    (await fs.stat(path.join(f.env.OPUSDESK_INSTALL_DIR, 'opus-desk'))).mode &
      0o777,
    0o755,
  );
  assert.match(await f.calls(), /claude auth status/);
  assert.match(await f.calls(), /configure --agent claude/);
  assert.doesNotMatch(await f.calls(), /codex|^start$/m);
});

test('installer refuses an invalid checksum without replacing an existing binary', async (t) => {
  const f = await fixture(t, { FIXTURE_DIGEST: '0'.repeat(64) });
  await fs.mkdir(f.env.OPUSDESK_INSTALL_DIR);
  const installed = path.join(f.env.OPUSDESK_INSTALL_DIR, 'opus-desk');
  await fs.writeFile(installed, 'keep existing');
  await assert.rejects(f.run(), /Checksum mismatch/);
  assert.equal(await fs.readFile(installed, 'utf8'), 'keep existing');
});

test('installer requires GitHub authentication before installing Opus Desk', async (t) => {
  const f = await fixture(t, { FIXTURE_AUTH: '0' });
  await assert.rejects(f.run(), /gh auth login/);
  await assert.rejects(
    fs.access(path.join(f.env.OPUSDESK_INSTALL_DIR, 'opus-desk')),
  );
});

test('installer identifies missing OAuth scopes and refuses unverifiable tokens', async (t) => {
  const missing = await fixture(t, { FIXTURE_SCOPES: 'repo' });
  await assert.rejects(missing.run(), /read:org,workflow/);
  const fineGrained = await fixture(t, { FIXTURE_SCOPES: '' });
  await assert.rejects(fineGrained.run(), /Cannot verify OAuth scopes/);
});

test('interactive pipe setup selects an agent, refreshes scopes, and completes sign-in', async (t) => {
  const f = await fixture(t, { FIXTURE_AUTH: '0', FIXTURE_SCOPES: 'repo' });
  delete f.env.OPUSDESK_NONINTERACTIVE;
  delete f.env.OPUSDESK_AGENT;
  f.env.FIXTURE_SCRIPT = script;
  const bin = path.join(f.dir, 'bin');
  const curl = path.join(bin, 'curl');
  await fs.writeFile(
    curl,
    (await fs.readFile(curl, 'utf8')).replace(
      '  *) exit 1 ;;',
      `  https://claude.ai/install.sh) cp "$HOME/native-installer" "$out" ;;\n  *) exit 1 ;;`,
    ),
  );
  await fs.writeFile(
    path.join(bin, 'brew'),
    '#!/bin/sh\nprintf "brew %s\\n" "$*" >> "$FIXTURE_CALLS"\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(f.dir, 'native-installer'),
    '#!/bin/sh\nprintf "native-installer %s\\n" "$*" >> "$FIXTURE_CALLS"\nmkdir -p "$HOME/.local/bin"\ncp "$HOME/agent-fixture" "$HOME/.local/bin/claude"\nchmod +x "$HOME/.local/bin/claude"\n',
  );
  await fs.writeFile(
    path.join(f.dir, 'agent-fixture'),
    `#!/bin/sh
printf 'claude %s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1 $2" in
  'auth status') [ -f "$HOME/agent-login" ] ;;
  'auth login') touch "$HOME/agent-login" ;;
  *) echo 'Claude latest fixture' ;;
esac
`,
  );
  await fs.writeFile(
    path.join(bin, 'gh'),
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1 $2" in
  'auth status') [ -f "$HOME/gh-login" ] ;;
  'auth login') touch "$HOME/gh-login" ;;
  'auth refresh') touch "$HOME/gh-refreshed" ;;
  'api --hostname') if [ -f "$HOME/gh-refreshed" ]; then scopes='repo, read:org, workflow, read:project'; else scopes=repo; fi; printf 'HTTP/2 200\\nx-oauth-scopes: %s\\n\\n{}\\n' "$scopes" ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = await exec(
    'python3',
    [
      fileURLToPath(
        new URL('./fixtures/installer-terminal.py', import.meta.url),
      ),
    ],
    { env: f.env, timeout: 30000 },
  );
  assert.match(result.stdout, /Choose your coding agent/);
  const calls = await f.calls();
  assert.match(
    calls,
    /gh auth login .*--scopes repo,read:org,workflow,read:project/,
  );
  assert.match(
    calls,
    /gh auth refresh .*--scopes repo,read:org,workflow,read:project/,
  );
  assert.match(calls, /native-installer latest/);
  assert.match(calls, /claude auth login/);
  assert.match(calls, /configure --agent claude --projects/);
  assert.doesNotMatch(calls, /^start$/m);
});
