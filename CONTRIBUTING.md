# Contributing to Opus Desk

Bug reports, focused fixes, tests, and documentation improvements are welcome. Discuss larger changes in an issue before investing in an implementation. Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Development

Use Node.js 24 (see `.nvmrc`), npm, Git, and Python 3 (for the installer terminal test). Node.js 22.14+ is also tested. GitHub CLI and at least one authenticated coding agent are needed to exercise real integrations; automated tests use isolated fixtures and require no provider credentials.

```sh
git clone https://github.com/jakecyr/opus-desk.git
cd opus-desk
nvm use # optional, if you use nvm
npm ci
npm run build
npm start
```

In another terminal:

```sh
npm run dev
```

Open the Vite URL printed in your terminal. Vite forwards `/api` requests to the local server on port 4317. Stop any detached daemon first with `npm run daemon -- stop`. For production-style source runs, use `npm run daemon -- start` after building.

To use a different backend port during development, set the same `PORT` in both terminals, for example `PORT=5000 npm start` and `PORT=5000 npm run dev`. You can also start the backend with `npm start -- --port 5000`.

## Project layout

| Path                                        | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `src/`                                      | React dashboard and styles                                         |
| `server/app.js`                             | Local HTTP API, polling, and workflows                             |
| `server/core.js`                            | GitHub helpers, project discovery, and state                       |
| `server/codex.js`, `server/claude.js`       | Agent integrations                                                 |
| `server/cli.js`, `server/daemon.js`, `bin/` | CLI configuration and process lifecycle                            |
| `test/`                                     | Node unit/integration tests, installer fixtures, and browser tests |
| `scripts/`                                  | Binary building, packaging, and smoke checks                       |
| `.github/`                                  | CI, release automation, ownership, and templates                   |

## Checks

```sh
npm run check
npx playwright install chromium
npm run test:ui
shellcheck install.sh
```

`npm run check` runs ESLint, Prettier, Node tests, and the dashboard build. Run `npm run format` to apply formatting. Use `npm run test:coverage` to see coverage. Tests isolate state and replace external CLIs; do not add tests that use personal credentials, make model calls, or mutate real GitHub items.

For runtime or packaging changes, also run:

```sh
npm run build:binary
npm run test:binary
node scripts/package-binary.js
```

Build binaries on the target operating system and architecture. Official CI covers macOS/Linux on arm64 and x64. Binary construction uses the Node executable supplied by your Node installation; its distribution must include `LICENSE` one level above `bin/node`.

## Pull requests and commits

Branch from the default branch, currently `master`. Keep changes focused, explain the resulting behavior, include relevant tests, and update documentation when commands or behavior change. Never commit local state, CLI credentials, conversation history, or `.env` files.

Use [Conventional Commits](https://www.conventionalcommits.org/) for the PR title and preferably for individual commits:

```text
feat(cli): add a friendly localhost name
fix(daemon): report a failed startup
chore(deps): update development tools
feat!: change the state format
```

CI validates PR titles. PRs are squash merged, using the PR title as the commit subject. `feat` and `fix` commits drive release versions; `!` or a `BREAKING CHANGE:` footer identifies a breaking change. Do not change package versions or tags by hand.

PRs targeting `main` or `master` normally must pass the **Quality gate**, be up to date, receive an approving code owner review, and resolve all review conversations. New code changes dismiss previous approvals. `@jakecyr` owns all files, including workflows and `CODEOWNERS`, and can explicitly bypass these requirements when merging a PR. This exception is limited to that account and PR merges; other contributors have no bypass.

GitHub does not permit authors to approve their own PRs. `@jakecyr` can use the PR merge bypass to merge their own work without another reviewer. Bots and release automation have no mainline bypass. Release tag restrictions remain in force.

## Releases

Only CI running after a successful push to the repository's default branch publishes releases. Merging a regular PR updates a release PR; a maintainer reviews and merges that release PR to publish its version, tag, changelog, and binaries. See the [release guide](docs/releases.md).
