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
const terminal = fileURLToPath(
  new URL('./fixtures/installer-terminal.py', import.meta.url),
);

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const stage = path.join(dir, 'stage');
  await fs.mkdir(bin);
  await fs.mkdir(stage);
  const write = (name, body) =>
    fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
  await fs.writeFile(
    path.join(stage, 'opus-desk'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
if [ "$1" = configure ] && [ "$FIXTURE_CONFIG_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/config-failed" ]; then
  touch "$HOME/config-failed"; exit 1
fi
`,
    { mode: 0o755 },
  );
  const archive = path.join(dir, 'archive.tar.gz');
  await exec('tar', ['-czf', archive, '-C', stage, 'opus-desk']);
  const digest = createHash('sha256')
    .update(await fs.readFile(archive))
    .digest('hex');
  const commands = {
    uname: `#!/bin/sh
case "$1" in -s) echo "$FIXTURE_OS" ;; -m) echo arm64 ;; *) exit 1 ;; esac
`,
    curl: `#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in -o|--output) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac
done
printf 'curl %s\\n' "$url" >> "$FIXTURE_CALLS"
case "$url" in
  */releases/latest) printf 'https://github.com/jakecyr/opus-desk/releases/tag/v1.2.3' ;;
  */SHA256SUMS) for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do printf '%s  opus-desk-%s.tar.gz\\n' "$FIXTURE_DIGEST" "$target"; done > "$out" ;;
  *.tar.gz)
    if [ "$FIXTURE_DOWNLOAD_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/download-failed" ]; then touch "$HOME/download-failed"; exit 22; fi
    cp "$FIXTURE_ARCHIVE" "$out" ;;
  https://claude.ai/install.sh|https://chatgpt.com/codex/install.sh)
    if [ "$FIXTURE_INSTALLER_BAD_ONCE" = 1 ] && [ ! -f "$HOME/installer-failed" ]; then
      touch "$HOME/installer-failed"; printf '<!DOCTYPE html>\\n' > "$out"
    elif [ "$FIXTURE_INSTALLER_HTML" = 1 ]; then printf '\\n<!DOCTYPE html>\\n<html>blocked</html>\\n' > "$out"
    elif [ "$FIXTURE_INSTALLER_INVALID" = 1 ]; then printf '#!/bin/sh\\nif then\\n' > "$out"
    else cp "$HOME/native-installer" "$out"; fi ;;
  *) exit 1 ;;
esac
`,
    gh: `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1 $2" in
  '--version ') [ "$FIXTURE_GH_MISSING" != 1 ] || [ -f "$HOME/deps-installed" ] ;;
  'auth status') [ "$FIXTURE_AUTH" = 1 ] || [ -f "$HOME/gh-login" ] ;;
  'auth login') touch "$HOME/gh-login" ;;
  'auth refresh')
    if [ "$FIXTURE_REFRESH_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/refresh-failed" ]; then touch "$HOME/refresh-failed"; exit 1; fi
    [ "$FIXTURE_REFRESH_INCOMPLETE" = 1 ] || touch "$HOME/gh-refreshed" ;;
  'api --hostname')
    if [ "$FIXTURE_API_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/api-failed" ]; then touch "$HOME/api-failed"; exit 1; fi
    scopes="$FIXTURE_SCOPES"
    [ ! -f "$HOME/gh-refreshed" ] || scopes='repo, read:org, workflow, read:project'
    printf 'HTTP/2 200\\nx-oauth-scopes: %s\\n\\n{}\\n' "$scopes" ;;
  *) exit 0 ;;
esac
`,
    git: `#!/bin/sh
printf 'git %s\\n' "$*" >> "$FIXTURE_CALLS"
[ "$FIXTURE_GIT_MISSING" != 1 ] || [ -f "$HOME/deps-installed" ]
`,
    brew: `#!/bin/sh
printf 'brew %s\\n' "$*" >> "$FIXTURE_CALLS"
if [ "$FIXTURE_BREW_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/brew-failed" ]; then touch "$HOME/brew-failed"; exit 1; fi
case "$*" in
  'install --cask claude-code')
    mkdir -p "$HOME/.local/bin"
    cp "$HOME/agent-fixture" "$HOME/.local/bin/claude"
    chmod +x "$HOME/.local/bin/claude" ;;
  'install gh'|'install git'|'install gh git') touch "$HOME/deps-installed" ;;
  *) exit 1 ;;
esac
`,
  };
  const agent = `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$FIXTURE_CALLS"
case "$1 $2" in
  '--version ') echo 'Agent fixture' ;;
  'auth status'|'login status') [ "$FIXTURE_AGENT_AUTH" = 1 ] || [ -f "$HOME/agent-login" ] ;;
  'auth login'|'login ')
    if [ "$FIXTURE_LOGIN_FAIL_ONCE" = 1 ] && [ ! -f "$HOME/login-failed" ]; then touch "$HOME/login-failed"; exit 1; fi
    [ "$FIXTURE_LOGIN_INCOMPLETE" = 1 ] || touch "$HOME/agent-login" ;;
  *) exit 0 ;;
esac
`;
  await fs.writeFile(path.join(dir, 'agent-fixture'), agent);
  for (const name of ['codex', 'claude']) {
    commands[name] = agent.replace(
      "  '--version ') echo",
      `  '--version ') [ "$FIXTURE_AGENT_MISSING" != 1 ] || exit 1; echo`,
    );
  }
  await fs.writeFile(
    path.join(dir, 'native-installer'),
    `#!/bin/sh
printf 'native-installer %s\\n' "$*" >> "$FIXTURE_CALLS"
if [ "$FIXTURE_NATIVE_FAIL" = 1 ]; then exit 1; fi
mkdir -p "$HOME/.local/bin"
cp "$HOME/agent-fixture" "$HOME/.local/bin/$FIXTURE_INSTALL_AGENT"
chmod +x "$HOME/.local/bin/$FIXTURE_INSTALL_AGENT"
`,
  );
  for (const [name, body] of Object.entries(commands)) await write(name, body);
  const env = {
    ...process.env,
    HOME: dir,
    SHELL: '/bin/zsh',
    PATH: `${bin}:/usr/bin:/bin`,
    OPUSDESK_NONINTERACTIVE: '1',
    OPUSDESK_AGENT: 'codex',
    OPUSDESK_INSTALL_DIR: path.join(dir, 'install'),
    FIXTURE_ARCHIVE: archive,
    FIXTURE_DIGEST: digest,
    FIXTURE_CALLS: path.join(dir, 'calls'),
    FIXTURE_SCRIPT: script,
    FIXTURE_AUTH: '1',
    FIXTURE_OS: 'Darwin',
    FIXTURE_AGENT_AUTH: '1',
    FIXTURE_INSTALL_AGENT: 'claude',
    FIXTURE_SCOPES: 'repo, read:org, workflow, read:project',
  };
  for (const key of Object.keys(env)) {
    if (
      /^(GH_|GITHUB_|OPUSDESK_)/.test(key) &&
      ![
        'OPUSDESK_NONINTERACTIVE',
        'OPUSDESK_AGENT',
        'OPUSDESK_INSTALL_DIR',
      ].includes(key)
    )
      delete env[key];
  }
  Object.assign(env, overrides);
  return {
    dir,
    env,
    write,
    run: () => exec('bash', [script], { env, timeout: 15000 }),
    interactive: (answers = {}) =>
      exec('python3', [terminal], {
        env: {
          ...env,
          OPUSDESK_NONINTERACTIVE: '0',
          OPUSDESK_AGENT: env.OPUSDESK_AGENT ?? '',
          FIXTURE_ANSWERS: JSON.stringify(answers),
        },
        timeout: 30000,
      }).catch((error) => {
        error.message += error.stdout;
        throw error;
      }),
    calls: () => fs.readFile(env.FIXTURE_CALLS, 'utf8'),
    installed: path.join(env.OPUSDESK_INSTALL_DIR, 'opus-desk'),
  };
}

test('installer verifies a release and configures the selected authenticated agent', async (t) => {
  const f = await fixture(t, { OPUSDESK_AGENT: 'claude' });
  const result = await f.run();
  assert.match(result.stdout, /Installed/);
  assert.equal((await fs.stat(f.installed)).mode & 0o777, 0o755);
  assert.doesNotMatch(await f.calls(), /claude auth status/);
  assert.match(await f.calls(), /configure --agent claude/);
  assert.doesNotMatch(await f.calls(), /codex|^start$/m);
});

test('installer refuses an invalid checksum without replacing an existing binary', async (t) => {
  const f = await fixture(t, { FIXTURE_DIGEST: '0'.repeat(64) });
  await fs.mkdir(f.env.OPUSDESK_INSTALL_DIR);
  await fs.writeFile(f.installed, 'keep existing');
  await assert.rejects(f.run(), /Checksum mismatch/);
  assert.equal(await fs.readFile(f.installed, 'utf8'), 'keep existing');
  assert.doesNotMatch(await f.calls(), /gh |native-installer|configure/);
});

test('unattended installation skips unavailable tools and authentication', async (t) => {
  const f = await fixture(t, {
    FIXTURE_AUTH: '0',
    FIXTURE_AGENT_AUTH: '0',
    FIXTURE_GH_MISSING: '1',
    FIXTURE_AGENT_MISSING: '1',
    OPUSDESK_START: '1',
  });
  await f.run();
  await fs.access(f.installed);
  assert.doesNotMatch(await f.calls(), /gh |codex |brew |native-installer/);
  assert.match(await f.calls(), /^restart$/m);
});

test('interactive installation can skip all integrations and start the app', async (t) => {
  const f = await fixture(t, { OPUSDESK_AGENT: '' });
  await f.interactive({
    'Configure GitHub hostname?': ['n'],
    'Configure your projects folder?': ['n'],
    'Set up GitHub tools and authentication?': ['n'],
    'Choose and set up a coding agent?': ['n'],
    'Start or restart Opus Desk now?': ['y'],
  });
  await fs.access(f.installed);
  const calls = await f.calls();
  assert.doesNotMatch(
    calls,
    /gh |codex |claude |configure|brew |native-installer/,
  );
  assert.match(calls, /^restart$/m);
});

test('enterprise users can retain CLI authentication and skip GitHub scope checks', async (t) => {
  const f = await fixture(t, {
    FIXTURE_SCOPES: '',
    FIXTURE_AGENT_AUTH: '0',
    GH_ENTERPRISE_TOKEN: 'fixture',
  });
  await f.interactive({
    'Check GitHub OAuth scopes and offer refresh?': ['n'],
    'Check codex login and offer its standard sign-in?': ['n'],
    'Start or restart Opus Desk now?': ['y'],
  });
  const calls = await f.calls();
  assert.doesNotMatch(calls, /gh api|gh auth refresh|codex login/);
  assert.match(calls, /^restart$/m);
});

test('interactive pipe setup installs a missing agent, refreshes scopes, and signs in', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_AGENT: '',
    FIXTURE_AUTH: '0',
    FIXTURE_SCOPES: 'repo',
    FIXTURE_AGENT_AUTH: '0',
    FIXTURE_AGENT_MISSING: '1',
  });
  const result = await f.interactive();
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
  assert.match(
    calls,
    /configure --agent claude --github-host github\.com --projects/,
  );
  assert.equal((result.stdout.match(/OAuth scopes verified/g) || []).length, 1);
  assert.doesNotMatch(calls, /brew |^restart$/m);
});

test('rerunning reuses dependencies, agent, binary, credentials, and PATH entry', async (t) => {
  const f = await fixture(t, { OPUSDESK_AGENT: 'claude' });
  await f.interactive();
  const before = await fs.stat(f.installed);
  const result = await f.interactive();
  assert.match(result.stdout, /already installed/);
  assert.equal((await fs.stat(f.installed)).ino, before.ino);
  assert.equal(
    (await fs.readFile(path.join(f.dir, '.zshrc'), 'utf8')).match(
      /# Opus Desk/g,
    ).length,
    1,
  );
  assert.doesNotMatch(
    await f.calls(),
    /brew |native-installer|auth (login|refresh)/,
  );
});

test('rerunning replaces a different existing binary with the latest release', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.env.OPUSDESK_INSTALL_DIR);
  await fs.writeFile(f.installed, 'old release');
  const result = await f.run();
  assert.match(result.stdout, /v1\.2\.3/);
  assert.match(await fs.readFile(f.installed, 'utf8'), /^#!\/bin\/sh/);
});

test('interactive setup accepts a pasted enterprise HTTPS URL and declining sign-in', async (t) => {
  const f = await fixture(t, {
    FIXTURE_AUTH: '0',
    FIXTURE_HOST: 'https://ghe.example.com/',
    FIXTURE_AUTH_ANSWER: 'n',
  });
  const result = await f.interactive();
  assert.match(result.stdout, /Skipping GitHub authentication/);
  const calls = await f.calls();
  assert.match(calls, /gh auth status --active --hostname ghe\.example\.com/);
  assert.doesNotMatch(calls, /gh auth (login|refresh|setup-git)|gh api/);
  assert.match(
    calls,
    /configure --agent codex --github-host ghe\.example\.com/,
  );
});

test('invalid confirmations, hosts, agent choices, and folders are re-prompted', async (t) => {
  const f = await fixture(t, { OPUSDESK_AGENT: '' });
  const result = await f.interactive({
    'Install Opus Desk?': ['maybe', 'yes'],
    'GitHub hostname [': [
      'ghe.example.com:443',
      'ghe..example.com',
      'ghe.example.com',
    ],
    'Choice [1]:': ['3', 'claude'],
    'Parent folder containing your Git repositories': [
      path.join(f.dir, 'missing'),
      '~',
    ],
  });
  assert.match(result.stdout, /Please enter y or n/);
  assert.match(result.stdout, /Invalid GitHub hostname/);
  assert.match(result.stdout, /Choose 1 or 2/);
  assert.match(result.stdout, /Projects folder does not exist/);
  assert.match(
    await f.calls(),
    /configure --agent claude --github-host ghe.example.com --projects/,
  );
  assert.equal((await f.calls()).match(/curl .*\.tar\.gz/g).length, 1);
});

for (const tool of ['gh', 'git']) {
  test(`installs only missing ${tool} without updating Homebrew or other tools`, async (t) => {
    const f = await fixture(t, {
      [`FIXTURE_${tool.toUpperCase()}_MISSING`]: '1',
    });
    await f.interactive();
    const calls = await f.calls();
    assert.match(calls, new RegExp(`^brew install ${tool}$`, 'm'));
    assert.equal((calls.match(/^brew /gm) || []).length, 1);
  });
}

for (const agent of ['codex', 'claude']) {
  test(`installs missing ${agent} with a validated native installer`, async (t) => {
    const f = await fixture(t, {
      OPUSDESK_AGENT: agent,
      FIXTURE_INSTALL_AGENT: agent,
      FIXTURE_AGENT_MISSING: '1',
    });
    await f.interactive();
    assert.match(await f.calls(), /native-installer/);
    assert.match(await f.calls(), new RegExp(`configure --agent ${agent}`));
  });
}

test('retries a package-manager failure without repeating completed steps', async (t) => {
  const f = await fixture(t, {
    FIXTURE_GH_MISSING: '1',
    FIXTURE_BREW_FAIL_ONCE: '1',
  });
  const result = await f.interactive();
  assert.match(result.stdout, /Retry GitHub dependencies/);
  assert.equal((await f.calls()).match(/^brew install gh$/gm).length, 2);
  assert.equal((await f.calls()).match(/curl .*\.tar\.gz/g).length, 1);
});

test('retries an invalid native download on Linux and then completes setup', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_AGENT: 'claude',
    FIXTURE_OS: 'Linux',
    FIXTURE_AGENT_MISSING: '1',
    FIXTURE_INSTALLER_BAD_ONCE: '1',
  });
  const result = await f.interactive();
  assert.match(result.stdout, /Retry claude installation/);
  assert.equal(
    (await f.calls()).match(/curl https:\/\/claude.ai\/install.sh/g).length,
    2,
  );
  assert.equal((await f.calls()).match(/native-installer latest/g).length, 1);
  assert.match(await f.calls(), /configure --agent claude/);
});

test('Codex also rejects HTML instead of executing it', async (t) => {
  const f = await fixture(t, {
    FIXTURE_AGENT_MISSING: '1',
    FIXTURE_INSTALLER_HTML: '1',
  });
  const result = await f.interactive({ 'Retry ': ['n'] });
  assert.match(result.stdout, /Invalid installer/);
  assert.doesNotMatch(await f.calls(), /native-installer|brew /);
  await fs.access(f.installed);
});

test('explicit agent update uses the native installer even when already installed', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_UPDATE_AGENT: '1',
    OPUSDESK_AGENT: 'claude',
  });
  await f.interactive();
  assert.match(await f.calls(), /native-installer latest/);
});

test('Claude HTML download is not executed and falls back to Homebrew on macOS', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_AGENT: 'claude',
    FIXTURE_AGENT_MISSING: '1',
    FIXTURE_INSTALLER_HTML: '1',
  });
  const result = await f.interactive();
  assert.match(result.stdout, /received HTML or other invalid content/);
  assert.match(result.stdout, /Homebrew alternative/);
  assert.doesNotMatch(result.stdout, /syntax error/);
  assert.match(await f.calls(), /brew install --cask claude-code/);
  assert.doesNotMatch(await f.calls(), /native-installer/);
  assert.match(await f.calls(), /configure --agent claude/);
});

test('Claude native execution failure also falls back to Homebrew', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_AGENT: 'claude',
    FIXTURE_AGENT_MISSING: '1',
    FIXTURE_NATIVE_FAIL: '1',
  });
  await f.interactive();
  assert.match(await f.calls(), /native-installer latest/);
  assert.match(await f.calls(), /brew install --cask claude-code/);
});

for (const invalid of ['HTML', 'INVALID']) {
  test(`refuses a ${invalid} installer on Linux and allows cancelling retry`, async (t) => {
    const f = await fixture(t, {
      OPUSDESK_AGENT: 'claude',
      FIXTURE_OS: 'Linux',
      FIXTURE_AGENT_MISSING: '1',
      [`FIXTURE_INSTALLER_${invalid}`]: '1',
    });
    const result = await f.interactive({ 'Retry ': ['n'] });
    assert.match(result.stdout, /Invalid installer/);
    assert.doesNotMatch(await f.calls(), /native-installer|brew /);
    await fs.access(f.installed);
  });
}

for (const [name, flag, pattern] of [
  ['release download', 'FIXTURE_DOWNLOAD_FAIL_ONCE', /curl .*\.tar\.gz/g],
  ['GitHub API', 'FIXTURE_API_FAIL_ONCE', /gh api --hostname/g],
  ['scope refresh', 'FIXTURE_REFRESH_FAIL_ONCE', /gh auth refresh/g],
  ['agent sign-in', 'FIXTURE_LOGIN_FAIL_ONCE', /codex login$/gm],
  ['configuration', 'FIXTURE_CONFIG_FAIL_ONCE', /^configure /gm],
]) {
  test(`retries failed ${name} without restarting setup`, async (t) => {
    const f = await fixture(t, {
      [flag]: '1',
      ...(name === 'scope refresh' ? { FIXTURE_SCOPES: 'repo' } : {}),
      ...(name === 'agent sign-in' ? { FIXTURE_AGENT_AUTH: '0' } : {}),
    });
    const result = await f.interactive();
    assert.match(result.stdout, /Retry /);
    const calls = await f.calls();
    assert.equal((calls.match(pattern) || []).length, 2);
    assert.equal((calls.match(/curl .*releases\/latest/g) || []).length, 1);
    assert.match(result.stdout, /Ready/);
  });
}

test('successful login command still requires a verified authenticated session', async (t) => {
  const f = await fixture(t, {
    FIXTURE_AGENT_AUTH: '0',
    FIXTURE_LOGIN_INCOMPLETE: '1',
  });
  const result = await f.interactive({ 'Retry ': ['n'] });
  assert.match(result.stdout, /sign-in is still incomplete/);
  await fs.access(f.installed);
});

test('incomplete OAuth refresh can be cancelled without repeatedly forcing login', async (t) => {
  const f = await fixture(t, {
    FIXTURE_SCOPES: 'repo',
    FIXTURE_REFRESH_INCOMPLETE: '1',
  });
  const result = await f.interactive({
    'GitHub access is still incomplete.': ['n'],
  });
  assert.match(result.stdout, /access is still incomplete/);
  assert.equal((await f.calls()).match(/gh auth refresh/g).length, 1);
});

test('environment tokens with missing scopes fail without attempting refresh', async (t) => {
  const f = await fixture(t, {
    FIXTURE_SCOPES: 'repo',
    GH_ENTERPRISE_TOKEN: 'fixture',
  });
  const result = await f.interactive();
  assert.match(result.stdout, /unset environment tokens first/);
  assert.doesNotMatch(await f.calls(), /gh auth refresh/);
});

test('unattended validation rejects invalid host, folder, agent, and flags', async (t) => {
  for (const overrides of [
    { OPUSDESK_GITHUB_HOST: 'github.com:443' },
    { OPUSDESK_GITHUB_HOST: 'bad-.example.com' },
    { OPUSDESK_GITHUB_HOST: 'x'.repeat(64) + '.example.com' },
    { OPUSDESK_PROJECTS_DIR: '/nonexistent-opus-desk-projects-fixture' },
    { OPUSDESK_AGENT: 'unknown' },
    { OPUSDESK_NONINTERACTIVE: 'yes' },
    { OPUSDESK_UPDATE_AGENT: '1' },
    { OPUSDESK_VERSION: 'invalid' },
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.run());
  }
});

test('unattended command failures exit without a prompt or partial install', async (t) => {
  const f = await fixture(t, { FIXTURE_DOWNLOAD_FAIL_ONCE: '1' });
  await assert.rejects(f.run(), /Release download failed/);
  assert.equal((await f.calls()).match(/curl .*\.tar\.gz/g).length, 1);
  await assert.rejects(fs.access(f.installed));
});

test('terminal EOF cancels without looping or changing the installation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.interactive({
      'Install Opus Desk?': [null],
    }),
    /Terminal input ended/,
  );
  await assert.rejects(fs.access(f.installed));
});

test('interactive mode without a controlling terminal gives unattended instructions', async (t) => {
  const f = await fixture(t, { OPUSDESK_NONINTERACTIVE: '0' });
  await assert.rejects(f.run(), /Interactive setup needs a terminal/);
});

test('unattended setup preserves a custom version, paths, host, and explicit start', async (t) => {
  const f = await fixture(t, {
    OPUSDESK_VERSION: 'v2.3.4',
    OPUSDESK_GITHUB_HOST: 'ghe.example.com',
    OPUSDESK_START: '1',
  });
  const projects = path.join(f.dir, 'projects with spaces');
  await fs.mkdir(projects);
  f.env.OPUSDESK_PROJECTS_DIR = projects;
  await f.run();
  const calls = await f.calls();
  assert.match(calls, /releases\/download\/v2\.3\.4/);
  assert.doesNotMatch(calls, /releases\/latest/);
  assert.match(
    calls,
    /--github-host ghe.example.com --projects .*projects with spaces/,
  );
  assert.match(calls, /^restart$/m);
});

test('updater replaces the actual executable and rejects a corrupt release', async (t) => {
  const f = await fixture(t);
  const installed = path.join(f.dir, 'installed');
  const alias = path.join(f.dir, 'alias');
  await fs.writeFile(installed, 'old release');
  await fs.symlink(installed, alias);
  const moduleUrl = new URL('../server/update.js', import.meta.url).href;
  const run = (env) =>
    exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { updateBinary } from ${JSON.stringify(moduleUrl)}; await updateBinary(process.argv[1]);`,
        alias,
      ],
      { env },
    );
  await assert.rejects(
    run({ ...f.env, FIXTURE_DIGEST: '0'.repeat(64) }),
    /Checksum mismatch/,
  );
  assert.equal(await fs.readFile(installed, 'utf8'), 'old release');
  const result = await run(f.env);
  assert.match(result.stdout, /v1\.2\.3/);
  assert.match(await fs.readFile(installed, 'utf8'), /^#!\/bin\/sh/);
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
});
