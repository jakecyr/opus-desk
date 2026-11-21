import fs from 'node:fs/promises';
import path from 'node:path';
import { githubUrl, getGithubHost, run } from './core.js';

function ciJobs(pull) {
  const jobs = new Set();
  for (const check of pull.statusCheckRollup || []) {
    if (!pull.failedChecks?.includes(check.name)) continue;
    if (
      !['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(
        check.conclusion,
      )
    )
      continue;
    try {
      const url = new URL(check.detailsUrl);
      if (url.host !== getGithubHost()) continue;
      const { repo } = githubUrl(pull.url);
      const prefix = '/' + repo.toLowerCase() + '/actions/runs/';
      if (!url.pathname.toLowerCase().startsWith(prefix)) continue;
      const match = url.pathname
        .slice(prefix.length)
        .match(/^\d+\/job\/(\d+)\/?$/);
      if (match) jobs.add(match[1]);
    } catch {}
  }
  return [...jobs].slice(0, 10);
}

export async function prepareAutomaticCheckout(
  { project, directory, pull, kind, discussion },
  execute = run,
) {
  const { repo, number } = githubUrl(pull.url);
  const hostname = getGithubHost();
  const cwd = path.join(directory, 'checkout');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (project) {
    await execute('git', [
      'clone',
      '--shared',
      '--no-checkout',
      '--no-tags',
      '--',
      project,
      cwd,
    ]);
  } else {
    await execute('git', ['init', '--quiet', cwd]);
  }
  const git = (args, options) => execute('git', ['-C', cwd, ...args], options);
  await git(['config', 'core.hooksPath', '/dev/null']);
  await git(['check-ref-format', 'refs/heads/' + pull.baseRefName]);
  const remote = 'https://' + hostname + '/' + repo + '.git';
  await git(
    [
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'fetch',
      '--no-tags',
      '--',
      remote,
      '+refs/pull/' + number + '/head:refs/opusdesk/head',
      '+refs/heads/' + pull.baseRefName + ':refs/opusdesk/base',
    ],
    {
      timeout: 120000,
      env: { ...process.env, GH_HOST: hostname, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  const head = (await git(['rev-parse', 'refs/opusdesk/head'])).trim();
  const base = (await git(['rev-parse', 'refs/opusdesk/base'])).trim();
  if (head !== pull.headRefOid || base !== pull.baseRefOid)
    throw Error('The pull request changed while fetching its Git references');
  await git(['checkout', '-q', '-B', 'opusdesk-work', 'refs/opusdesk/head']);
  if (project && kind !== 'review') {
    for (const key of ['user.name', 'user.email']) {
      const value = (
        await execute('git', ['-C', project, 'config', key]).catch(() => '')
      ).trim();
      if (value) await git(['config', key, value]);
    }
  }
  if (kind === 'conflicts') {
    await git([
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-commit',
      '--no-ff',
      'refs/opusdesk/base',
    ]).catch(async (error) => {
      if (!(await git(['diff', '--name-only', '--diff-filter=U'])).trim())
        throw error;
    });
  }
  const logs = await Promise.all(
    ciJobs(pull).map(async (job) => {
      if (kind !== 'ci') return '';
      const log = await execute('gh', [
        'run',
        'view',
        '--job',
        job,
        '--log-failed',
        '-R',
        hostname + '/' + repo,
      ]).catch(() => '');
      return log ? 'Job ' + job + '\n' + log.slice(-40000) : '';
    }),
  );
  const context = path.join(directory, 'github-context.json');
  await fs.writeFile(
    context,
    JSON.stringify({
      base: 'refs/opusdesk/base',
      head: 'refs/opusdesk/head',
      checks: kind === 'ci' ? pull.failedChecks : undefined,
      logs: logs.filter(Boolean),
      discussion,
    }),
    { mode: 0o600 },
  );
  return { cwd, context };
}

export async function collectAutomaticFix(task, execute = run) {
  const fsInfo = await fs.lstat(task.artifact);
  if (!fsInfo.isFile() || fsInfo.size > 16384)
    throw Error('Invalid workflow result');
  const result = JSON.parse(await fs.readFile(task.artifact, 'utf8'));
  if (
    !Array.isArray(result.checks) ||
    result.checks.length > 20 ||
    result.checks.some(
      (check) => typeof check !== 'string' || check.length > 500,
    ) ||
    typeof result.tested !== 'boolean'
  )
    throw Error('The agent did not provide a valid test summary');
  await fs.unlink(task.artifact);
  const git = (args) => execute('git', ['-C', task.cwd, ...args]);
  if ((await git(['rev-parse', 'HEAD'])).trim() !== task.initialHead)
    throw Error(
      'The prepared checkout advanced before its results were collected',
    );
  await git(['add', '-A']);
  await git(['diff', '--cached', '--check']);
  const diff = (await git(['diff', '--cached', '--name-only'])).trim();
  const mergeParent = (
    await git(['rev-parse', '--verify', 'MERGE_HEAD']).catch(() => '')
  ).trim();
  if (mergeParent && mergeParent !== task.base)
    throw Error('The prepared merge base changed');
  if (diff || (mergeParent && task.kind === 'conflicts')) {
    const message = {
      ci: 'fix: repair pull request checks',
      conflicts: 'Merge pull request base',
      comments: 'fix: address review feedback',
    }[task.kind];
    await git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      message,
    ]);
  }
  return {
    tested: result.tested && result.checks.length > 0,
    checks: result.checks,
  };
}
