# Installation

## Interactive setup

```sh
curl -fsSL https://github.com/jakecyr/opus-desk/releases/latest/download/install.sh | bash
```

The script uses `/dev/tty` for questions, even when piped to Bash. It asks before setting up dependencies, installing/updating the selected agent, and starting the daemon. Homebrew's own installer may ask for administrator access. Opus Desk itself installs to `~/.local/bin` without sudo. If needed, it offers to add the binary directory to your Bash or Zsh profile. Other shells receive a PATH instruction.

GitHub CLI signs in through its browser flow. OAuth scopes `repo`, `read:org`, `workflow`, and `read:project` cover repository workflows, organization visibility, and agent fixes to GitHub Actions files, and read access to GitHub Projects. Missing scopes prompt `gh auth refresh`. Tokens supplied through `GH_TOKEN`/`GITHUB_TOKEN` cannot be refreshed interactively; unset them and rerun setup. Fine-grained token permissions cannot be inferred from OAuth scope headers, so the installer asks for a verifiable CLI OAuth login instead of claiming to validate them. Organization SSO, repository access, and protected branch rules still apply.

The selected agent is installed or updated using the official native latest-release installer and its version is printed. Existing versions installed by another package manager are retained; `~/.local/bin` takes precedence for this setup. The installer checks `codex login status` or `claude auth status`, opens the appropriate login flow if needed, and checks again. It never runs a paid test prompt or writes provider credentials itself.

Official setup references, checked November 5, 2026: [Codex](https://learn.chatgpt.com/docs/cli), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Claude Code](https://code.claude.com/docs/en/setup), [Claude CLI authentication](https://code.claude.com/docs/en/cli-reference), [GitHub CLI](https://cli.github.com/manual/gh_auth_login), and [Homebrew](https://brew.sh/).

## Inspect first or choose a version

```sh
curl -fsSL https://github.com/jakecyr/opus-desk/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
```

Set `OPUSDESK_VERSION=vX.Y.Z` to install a specific stable binary version. Archives and checksums are resolved from one release tag. A checksum failure stops the installation before replacing the executable. Release checksums detect corrupted downloads; they are not independent signatures.

Supported release targets are macOS arm64/x64 and Linux arm64/x64. Linux binaries require glibc 2.28+ (Alpine/musl is not supported). macOS binaries use ad hoc signing and are not Apple notarized.

## Preconfigured or unattended machines

Dependencies and credentials must already work in this mode; it does not install dependencies, update agents, open a login flow, or start the daemon unless requested.

```sh
OPUSDESK_NONINTERACTIVE=1 OPUSDESK_AGENT=codex bash install.sh
```

| Variable                  | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `OPUSDESK_AGENT`          | `codex` or `claude`                                         |
| `OPUSDESK_VERSION`        | A stable `vX.Y.Z` tag; default `latest`                     |
| `OPUSDESK_INSTALL_DIR`    | Destination; default `~/.local/bin`                         |
| `OPUSDESK_PROJECTS_DIR`   | Existing parent folder containing Git repositories          |
| `OPUSDESK_NONINTERACTIVE` | `1` validates preconfigured dependencies and authentication |
| `OPUSDESK_START`          | `1` starts the daemon after setup                           |
| `OPUSDESK_DATA_DIR`       | Overrides the state and log directory                       |

The script does not change repository settings or your Git identity. Git uses your existing identity for commits. GitHub's Git credential helper is configured through `gh auth setup-git`.

## Commands and local URLs

```sh
opus-desk start
opus-desk status
opus-desk restart --port 5000 --hostname opus-desk.localhost
opus-desk stop
opus-desk run # foreground
opus-desk configure --agent claude --projects "$HOME/Projects"
```

`PORT` and `OPUSDESK_HOSTNAME` also configure the server. `configure` applies settings to a running daemon immediately; restart when changing its port or hostname. The server always binds to `127.0.0.1` and accepts only the selected hostname plus standard loopback names on its listening port.

`.localhost` names follow [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.3). Browser/OS support varies; the reliable fallback is `http://127.0.0.1:PORT`. No `/etc/hosts` changes, LAN DNS service, root privileges, or reverse proxy are needed. Removing the port would require an additional listener/proxy on port 80/443, which this installer does not configure.

## Updates and removal

Rerun the installer for updates, then run `opus-desk restart` to switch an already running daemon to the new binary. State is preserved. The daemon survives a closed terminal; it does not restart at login or after a reboot, and it is not a supervised service.

For removal, run `opus-desk stop` and remove `~/.local/bin/opus-desk` (or your custom installation path). State, logs, and retained worktrees are under `~/.local/share/prquay`; inspect them before deleting. GitHub CLI, agents, and Homebrew are managed independently and are left installed.

## Troubleshooting

- **Command not found:** add `~/.local/bin` to PATH using the instruction printed by setup, then open a new terminal.
- **Port already in use:** choose another port with `opus-desk start --port 5000`.
- **Startup failed:** inspect `~/.local/share/prquay/daemon.log` and run `opus-desk run` to see errors directly.
- **Interrupted lifecycle command:** verify no start/stop command is still running before removing a stale `daemon.lock` from the state directory.
- **Missing releases:** use the developer setup until the first reviewed release PR is merged and CI publishes its assets.
- **CLI authentication/SSO errors:** rerun the relevant provider's login or GitHub's scope refresh and authorize any required organization SSO.
