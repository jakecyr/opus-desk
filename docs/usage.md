# Opus Desk usage

A local-first dashboard for GitHub work and Codex or Claude Code sessions. Opus Desk uses your existing local CLI authentication. GitHub and model-provider requests go to those services through the installed CLIs.

## Running the app

Use the [interactive installer](installation.md) or the [developer setup](../CONTRIBUTING.md#development). Open http://127.0.0.1:4317 after starting the daemon. The server binds to loopback only. Configure the projects directory in Settings. It polls GitHub through `gh` every two minutes by default. Desktop notifications require browser permission and an open dashboard.

## Current scope

Focus refreshes from GitHub and shows PRs that still need your attention. Pull Requests separates work you have to review, work already under review, and your own PRs. Use the status filters to find draft reviews, PRs waiting for a response, unresolved feedback, mergeable PRs, and failing checks. Paste a PR URL to review it or open its linked chat. Code repairs and issue actions use a local checkout. Reviews can fetch their own checkout.

In Settings, set the GitHub hostname for an Enterprise installation and sign in to that host with `gh`. Orchestrator searches the messages and titles of local Codex and Claude chats across projects. Sort by recent activity or name, or start a chat in a project or folder. Change the model and reasoning for the next turn in the chat controls. Use **Steer** while Codex is working. Claude's **Stop and send** ends the active turn and resumes the same chat with your message. **Stop** is available for turns running under Opus Desk.

PR cards with failing checks show **Fix CI**. Clicking it resumes the PR's linked chat or starts a new one using the configured CI workflow agent. The agent inspects the current failures and job logs, fixes the problem, runs relevant checks, and commits locally. This action authorizes Opus Desk to push those commits to the existing PR source branch, including a fork branch. Before pushing, the app checks for a clean checkout, the original PR head in the commit ancestry, and an unchanged remote PR head. Push failures appear on Focus for inspection and retry.

PR and issue actions start in the background and keep you on the current page. Cards on Focus, Pull Requests, Issues, and Sprint show the current task with a spinner, disable their action buttons while it runs, and offer a Chat link. Other cards remain available. Duplicate requests for the same running workflow reuse its job; a different action on a busy item is blocked. New PR chats use separate worktrees by default. A linked chat whose checkout is already busy, or has uncommitted changes for a PR action, is replaced with an isolated chat.

Codex and Claude run under a separate detached agent host. Closing the browser, stopping Opus Desk, or restarting its dashboard server does not stop accepted agent turns. The host owns the CLI connections, retains interactive Codex requests, saves job results, and completes authorized Fix CI pushes even while the dashboard is stopped. Reopening Opus Desk reconnects to the same host and recovers progress and results. Stopping the dashboard stops new polling and scheduling; it does not cancel existing work. Jobs do not survive a machine restart or termination of the agent host itself. Host logs and job records are in the `agents/` directory beneath the app's state directory.

Stop it with `npm run daemon -- stop` and check it with `npm run daemon -- status`. The detached daemon does not start automatically at login.

Claude Code history and noninteractive turns are available when its CLI is installed. Interactive questions and approvals use supported Codex protocol types. Opus Desk retains local worktrees for inspection.

Agent permissions default to full access without approval, matching the requested local CLI aliases; sandbox mode remains selectable. The dangerous mode grants the agent broad local access without prompts. Review the selected mode before launching. Code and issue text are untrusted input to agents. All application state is stored at `~/.local/share/prquay/state.json` with user-only permissions.

## Development

Run `npm start` in one terminal and `npm run dev` in another (stop the detached daemon first). Run `npm test` and `npm run build` before contributing.

## Worktrees and cleanup

New sessions and issue jobs can run in a separate Git worktree; the choice is remembered per project. Bulk issue jobs start separate sessions in parallel and default to separate worktrees. Each worktree starts from committed `HEAD` on a new `prquay/` branch. Uncommitted changes in the original checkout are not copied. Worktrees are kept after the work finishes and can be inspected or removed with Git. Selecting the same checkout for parallel sessions can cause conflicting edits.

Cleanup lists stale open PRs in your GitHub inbox and open issues assigned to you or in locally discovered repositories. The cutoff is based on last update; GitHub searches and access permissions limit what is shown. Closing selected items acts on GitHub after an in-app confirmation. It does not delete branches or worktrees; failures are reported per item.

The notification inbox is stored in this browser. Desktop notifications and the inbox receive new events while the dashboard is open; they do not collect events while it is closed. Browser site permissions may also need to be enabled.

## Auto mode

Auto mode starts off and runs while the local daemon is running. It picks up requested reviews, replies to your reviews, and conflicts or failing checks on your own PRs. Each task runs in an isolated checkout pinned to the GitHub revision. Opus Desk runs one task at a time and records the trigger so repeated polls do not restart unchanged work.

Open **Settings → Workflows** to choose **Off**, **Draft**, or **Publish** for each Auto action. First review and re-review default to creating a pending GitHub review. Conflict and CI fixes default to preparing local commits for approval. Addressing review comments automatically is also available and starts off. **Publish** opts that action into live GitHub review submission or pushing a tested fix to the existing PR branch. The app rechecks current settings and PR state before publishing. Turning off Auto stops new jobs and automatic publication. A running agent can finish preparing its result.

Automatic turns use restricted shell access in the local CLI and get GitHub evidence before the turn starts. Tests that need unavailable dependencies or network access can leave a fix awaiting manual review. Automatic Claude turns require Claude Code 2.1.319 or later with working sandbox support.

Configure **Settings → Code reviews** to choose the criteria, tone, and related repositories. Reviews prioritize verified defects, check exact dependency versions and release history where relevant, and use native GitHub suggestions for focused replacements. Optional nits are off by default.

## Terminal session guard

For existing chats, Opus Desk checks for an interactive terminal running the same agent in the same project before sending a message or resuming a linked chat. It blocks those actions while that terminal is open. The CLI does not expose reliable cross-process session ownership, so this deliberately blocks other chats in the same project too. It cannot reliably identify sessions open in other desktop clients. If the terminal check is unavailable, resuming is blocked rather than guessing.

## Sprint and issue tools

Settings saves changes automatically and loads model choices from the installed agent CLIs. Choose Other to use a custom model name. Workflows can override the agent, model, reasoning, and permissions.

The Sprint page appears after you select a repository and one of its linked GitHub Projects in Settings. Reading Projects requires `read:project` access in the existing GitHub CLI login. Opus Desk does not change your login or scopes automatically. Sprint defaults to tasks assigned to the detected or configured GitHub username; clear that filter to see everyone. Iteration dates come from the project. GitHub issues show linked closing PRs, a comment form, and an agent action for empty descriptions. Generated descriptions wait for publishing approval. Needs reply is a heuristic: the latest human comment on an authored or assigned issue is from someone else.

## Publishing approvals

Focus shows prepared agent results. Review the proposed comments, description, or code diff, then click Publish to GitHub. The app rechecks the reviewed commit and pending comments or local commit before publishing. Changed drafts and new PR commits require refreshing or re-running the work. When you explicitly submit an existing GitHub draft, the full pending review is submitted. Automated publishing uses the findings from its own run and leaves pre-existing draft reviews for you to submit.

Manual agents with full-access permissions retain shell and network access. Use sandbox permissions for manual work that should run with restricted filesystem and network access. Fix CI prepares changes for you to preview and publish from Focus.
