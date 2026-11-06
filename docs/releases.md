# Reviewed changes and CI releases

The default branch is currently `master`. CI also runs on `main` so a future rename keeps checks working. The release workflow checks the repository's actual default branch and ignores all other branches, pull request events, failed runs, and obsolete push runs.

## Contributor workflow

1. Open a PR with a Conventional Commit title.
2. CI runs ESLint/Prettier, shell checks, unit/integration/installer tests on Node 22 and 24, browser tests, and native binary smoke tests on all four release targets.
3. The **Quality gate** succeeds only if every job succeeds. Normally the branch must be up to date, the code owner must approve after the latest changes, and all review threads must be resolved before squash merging. `@jakecyr` can explicitly bypass mainline requirements when merging a PR, including their own PRs.
4. Successful default-branch CI updates a release PR containing the version and changelog changes. CI is explicitly dispatched on bot-created release PRs because GitHub's built-in token does not automatically trigger another PR workflow.
5. The owner reviews and merges the release PR under the same protections. Successful CI then creates a draft release, attaches the tested binaries, installer, licenses, and checksums, creates the tag using the release-only deploy key, and publishes the completed release.

No local release command, developer token, or automatic merge bypass is part of this process. `feat:` drives minor releases; `fix:` drives patch releases; breaking changes use `!` or a `BREAKING CHANGE:` footer. Other commit types normally wait for a releasable change. The first release starts at 0.1.0. Release Please updates `package.json`, `package-lock.json`, `.release-please-manifest.json`, and `CHANGELOG.md` through reviewed release PRs.

## Enforced repository settings

The checked-in [rulesets](../.github/rulesets/) are applied to GitHub, not just documented suggestions:

- `main`/`master`: PR required, one approving review, required code owner approval, stale approvals dismissed, approval after the latest push, all review threads resolved, strict **Quality gate** from GitHub Actions, squash merges, no force pushes, and no deletions. The only bypass actor is the `@jakecyr` user account, limited to PR merges. Other contributors and bots have no mainline bypass.
- Every tag: creation restricted to deploy keys; the sole write deploy key is the CI release key. No actor can update or delete existing tags under the tag immutability ruleset.
- `release` environment: only the exact default branch can access its release key. The key is unavailable to feature branches, forks, ordinary CI, and developer machines.
- Actions tokens default to read-only. Only the release job receives repository write permissions. The repository allows Actions to open release PRs; that setting also technically permits bot approvals, but bots are not code owners and cannot satisfy the required owner approval.
- `.github/CODEOWNERS` assigns all files, including ownership and workflow configuration, to `@jakecyr`. Ownership enforcement takes effect once that file is present on the PR's base branch.

GitHub does not let PR authors approve their own work. The explicit owner PR bypass lets `@jakecyr` merge without another reviewer; it can also override required checks and conversation resolution for that merge. It does not permit direct pushes or bypass release tag restrictions. Administrators can edit repository settings, and GitHub does not provide a separate rule forbidding an administrator from publishing a release against an already existing tag. Protected tag creation, immutable tags, restricted CI credentials, and the reviewed workflow are the available controls; this is not a claim that GitHub removes the administrator's own powers.

## Maintainer administration

Repository configuration is reproducible with:

```sh
node scripts/configure-repository.js --apply
```

This requires repository administration access. It updates the description, merge behavior, Actions permission setting, rulesets, private vulnerability reporting, and the release environment. On first setup it generates a dedicated SSH deploy key, stores the private key as `RELEASE_TAG_SSH_KEY` in the protected environment, registers the public key, and removes the temporary local copy. It never grants the key a mainline merge bypass. Keep other write deploy keys out of this repository: GitHub's deploy-key bypass actor covers that actor type rather than one key ID.

To rotate the release key, revoke its deploy key and environment secret through GitHub administration and rerun setup. Do not copy the private key to developer machines or use it outside CI. If the default branch is renamed, update the release environment's branch policy through the same administration process.

## Artifacts and failed releases

CI builds with Node 24 and Node's single executable application support. The server dependencies and frontend are bundled; users do not need Node/npm. macOS binaries are ad hoc signed. The archive contains `opus-desk`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`.

Each successful CI build uploads a target archive. The release job downloads archives only from the successful default-branch CI run and verifies that the proposed release SHA equals that tested commit. `SHA256SUMS` covers all four platform archives. Releases remain draft until the artifacts and tag are ready.

If publication fails, inspect the failed workflow and draft release. Repair the pipeline through a reviewed PR and rerun the relevant CI/release run; do not move existing tags or publish a replacement by hand. CI artifacts are retained for 14 days, so failed releases should be investigated promptly.
