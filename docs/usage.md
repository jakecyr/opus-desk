# Opus Desk usage

A local-first dashboard for GitHub work and Codex sessions. Opus Desk runs on your machine and uses your existing `gh` and Codex CLI authentication. It does not run a hosted service or upload your conversation history to a third-party dashboard. GitHub and model-provider requests still go to those services when their CLIs operate.

## Running the app

Use the [interactive installer](installation.md) or the [developer setup](../CONTRIBUTING.md#development). Open http://127.0.0.1:4317 after starting the daemon. The server binds to loopback only. Configure the projects directory in Settings. It polls GitHub through `gh` every two minutes by default. Desktop notifications require browser permission and an open dashboard.

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

## Auto mode

Auto mode defaults to off and runs only while the local daemon is running. When enabled, it watches GitHub for requested reviews, conflicts and failing checks on your PRs, unresolved review feedback on your PRs, and assigned issues. It starts one agent at a time in a new worktree and records the condition it handled to avoid repeating unchanged work. Auto mode prepares local commits, proposed PR details, and pending draft reviews. Finished work appears on Focus for you to inspect and explicitly publish. It does not schedule further work on the same item while that result awaits your decision. Turning it off stops new starts but does not cancel a task already running. It uses the configured agent permissions, which default to unrestricted access. Check the results before merging.

## Terminal session guard

For existing chats, Opus Desk checks for an interactive terminal running the same agent in the same project before sending a message or resuming a linked chat. It blocks those actions while that terminal is open. The CLI does not expose reliable cross-process session ownership, so this deliberately blocks other chats in the same project too. It cannot reliably identify sessions open in other desktop clients. If the terminal check is unavailable, resuming is blocked rather than guessing.

## Sprint and issue tools

Settings saves changes automatically and loads model choices from the installed agent CLIs. Choose Other to use a custom model name. Workflows can override the agent, model, reasoning, and permissions.

The Sprint page appears after you select a repository and one of its linked GitHub Projects in Settings. Reading Projects requires `read:project` access in the existing GitHub CLI login. Opus Desk does not change your login or scopes automatically. Sprint defaults to tasks assigned to the detected or configured GitHub username; clear that filter to see everyone. Iteration dates come from the project. GitHub issues show linked closing PRs, a comment form, and an agent action for empty descriptions. Generated descriptions wait for publishing approval. Needs reply is a heuristic: the latest human comment on an authored or assigned issue is from someone else.

## Publishing approvals

Focus shows prepared agent results. Review the proposed comments, description, or code diff, then click Publish to GitHub. The app rechecks the reviewed commit and pending comments or local commit before publishing. Changed drafts and new PR commits require refreshing or re-running the work. Draft review publication submits the entire pending review, including user-added drafts shown in the preview. Local worktrees are retained after publishing or dismissal.

This is the app's workflow publication policy, not an operating-system security boundary. Agents running with dangerous permissions retain full shell and network access. The prompts tell them to stop before publication; the app's publishing endpoints require an explicit user action. Use sandbox permissions when unrestricted agent access is unsuitable.
