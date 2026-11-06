# Opus Desk

A local-first dashboard for GitHub work and Codex sessions. Opus Desk runs on your machine and uses your existing `gh` and Codex CLI authentication. It does not run a hosted service or upload your conversation history to a third-party dashboard. GitHub and model-provider requests still go to those services when their CLIs operate.

## Run

Requires Node 20.19+ (or 22.12+), GitHub CLI and Codex CLI. Sign in to each CLI through its normal flow if needed.

```sh
npm install
npm run build
npm run daemon -- start
```

Open http://127.0.0.1:4317. The server binds to loopback only. Set the projects directory in Settings; immediate child folders that are Git repositories are discovered; PR actions require a matching GitHub origin. It polls GitHub through `gh` every two minutes by default. Desktop notifications require browser permission and an open dashboard.

## Current scope

Opus Desk lists open PRs involving you, requests for your review, your authored PRs, assigned issues, and local Codex sessions. It can start and resume Codex sessions, route supported Codex questions and approvals, and launch contextual PR and issue tasks. PR actions require a local checkout. Draft-review creation is requested of the agent and depends on its tool access and GitHub permissions; inspect the agent output and GitHub before relying on it.

Stop it with `npm run daemon -- stop` and check it with `npm run daemon -- status`. The detached daemon does not start automatically at login.

Claude Code history and noninteractive turns are supported when its CLI is installed; this has not been tested on a machine with Claude installed. Claude default permission mode is not a sandbox guarantee, and interactive Claude permissions and questions are not supported in this version. Existing Codex Cloud chats, background desktop notifications, automatic worktree cleanup, comprehensive PR classification, and repository-wide issue discovery are not implemented yet. Opus Desk does not delete worktrees automatically. Some Codex questions and approvals may use protocol types this early build does not yet support.

Agent permissions default to full access without approval, matching the requested local CLI aliases; sandbox mode remains selectable. The dangerous mode grants the agent broad local access without prompts. Review the selected mode before launching. Code and issue text are untrusted input to agents. All application state is stored at `~/.local/share/prquay/state.json` with user-only permissions.

## Development

Run `npm start` in one terminal and `npm run dev` in another (stop the detached daemon first). Run `npm test` and `npm run build` before contributing.

## Worktrees and cleanup

New sessions and issue jobs can run in a separate Git worktree; the choice is remembered per project. Bulk issue jobs start separate sessions in parallel and default to separate worktrees. Each worktree starts from committed `HEAD` on a new `prquay/` branch. Uncommitted changes in the original checkout are not copied. Worktrees are kept after the work finishes and can be inspected or removed with Git. Selecting the same checkout for parallel sessions can cause conflicting edits.

Cleanup lists stale open PRs in your GitHub inbox and open issues assigned to you or in locally discovered repositories. The cutoff is based on last update; GitHub searches and access permissions limit what is shown. Closing selected items acts on GitHub after an in-app confirmation. It does not delete branches or worktrees; failures are reported per item.

The notification inbox is stored in this browser. Desktop notifications and the inbox receive new events while the dashboard is open; they do not collect events while it is closed. Browser site permissions may also need to be enabled.
