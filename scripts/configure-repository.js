import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Maintainer-only, explicit operation. The user installer never runs this.
if (process.argv[2] !== '--apply')
  throw new Error(
    'Use --apply to configure the GitHub repository. Requires repository administration permission.',
  );
const repo = 'jakecyr/opus-desk';
function api(method, endpoint, body) {
  return JSON.parse(
    execFileSync(
      'gh',
      ['api', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])],
      {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
      },
    ) || 'null',
  );
}
const metadata = api('GET', `repos/${repo}`);
api('PUT', `repos/${repo}/environments/release`, {
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
});
const policies = api(
  'GET',
  `repos/${repo}/environments/release/deployment-branch-policies`,
);
if (
  !policies.branch_policies.some(
    (item) => item.name === metadata.default_branch && item.type === 'branch',
  )
) {
  api('POST', `repos/${repo}/environments/release/deployment-branch-policies`, {
    name: metadata.default_branch,
    type: 'branch',
  });
}
const keyTitle = 'Opus Desk CI release tags';
const keys = api('GET', `repos/${repo}/keys`);
if (!keys.some((key) => key.title === keyTitle)) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'opus-release-key-'),
  );
  let created;
  try {
    const key = path.join(temporary, 'release');
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      keyTitle,
      '-f',
      key,
    ]);
    created = api('POST', `repos/${repo}/keys`, {
      title: keyTitle,
      key: await fs.readFile(`${key}.pub`, 'utf8'),
      read_only: false,
    });
    execFileSync(
      'gh',
      [
        'secret',
        'set',
        'RELEASE_TAG_SSH_KEY',
        '--env',
        'release',
        '--repo',
        repo,
      ],
      { input: await fs.readFile(key) },
    );
    console.log(
      'Stored the CI release key in the protected release environment.',
    );
  } catch (error) {
    if (created) api('DELETE', `repos/${repo}/keys/${created.id}`);
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
api('PATCH', `repos/${repo}`, {
  description:
    'A local-first dashboard for GitHub PRs, issues, and Codex/Claude sessions, with background agent workflows.',
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
  delete_branch_on_merge: true,
});
api('PUT', `repos/${repo}/actions/permissions/workflow`, {
  default_workflow_permissions: 'read',
  can_approve_pull_request_reviews: true,
});
const existing = api('GET', `repos/${repo}/rulesets`);
for (const file of ['mainline', 'tag-creation', 'tag-immutability']) {
  const rule = JSON.parse(
    await fs.readFile(
      new URL(`../.github/rulesets/${file}.json`, import.meta.url),
      'utf8',
    ),
  );
  const previous = existing.find((item) => item.name === rule.name);
  const saved = api(
    previous ? 'PUT' : 'POST',
    `repos/${repo}/rulesets${previous ? `/${previous.id}` : ''}`,
    rule,
  );
  console.log(`${saved.name}: ${saved.enforcement} (${saved.id})`);
}
api('PUT', `repos/${repo}/private-vulnerability-reporting`);
console.log(
  `Configured ${repo}; releases use the protected ${metadata.default_branch} branch.`,
);
