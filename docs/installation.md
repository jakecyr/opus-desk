# Installation

## Interactive setup

```sh
curl -fsSL https://github.com/jakecyr/opus-desk/releases/latest/download/install.sh | bash
```

The script uses `/dev/tty` for questions, even when piped to Bash. It installs the checksum-verified Opus Desk binary first, then offers optional GitHub, project folder, agent, PATH, and startup steps. Skip any integration to configure it later. If an optional step fails, decline its retry prompt to continue; the installed application remains available. Terminal EOF ends setup.

GitHub setup can install missing Git and GitHub CLI tools with Homebrew and offers browser login, OAuth scope checks, and Git credential setup. Each is optional. You can choose a GitHub Enterprise hostname (such as `ghe.example.com`) and change it later with `opus-desk configure --github-host HOST` or in Settings. Fine-grained and enterprise tokens may not expose OAuth scope headers; skip the scope check when your organization manages permissions. Repository permissions and organization SSO still apply.

You can select Codex or Claude Code and use an existing CLI, optionally install it, or skip agent setup. Login checks and standard sign-in are optional: skip them when your organization uses custom endpoints, credentials, proxies, or another supported provider configuration. Configure those settings in the CLI using your organization's instructions. Opus Desk launches the installed CLI and inherits its environment; start or restart Opus Desk from a shell with any required environment variables set. It does not set endpoint URLs or credentials itself. Your CLI and enterprise endpoint must support the features Opus Desk uses (Codex `app-server` or Claude Code's CLI interface); matching the HTTP API format alone does not guarantee compatibility. An already-running background agent host may need to be stopped before it picks up changed environment variables.

Existing agent installations are not updated by default. Set `OPUSDESK_UPDATE_AGENT=1` for an explicit interactive update. Downloads are checked for a shell-script header and valid syntax before execution. If Claude's native installer fails, macOS setup can use Homebrew. Opus Desk installs to `~/.local/bin` without sudo and can add that directory to your Bash or Zsh profile. Project folders must already exist; `~` and `~/...` are accepted at the prompt. An identical binary is reused; a different release is replaced atomically.

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

This mode installs Opus Desk without checking, installing, or authenticating GitHub or agent tools. It does not start the daemon unless requested. Supply optional settings only when you want to change them.

```sh
OPUSDESK_NONINTERACTIVE=1 bash install.sh
```

| Variable                  | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `OPUSDESK_AGENT`          | `codex` or `claude`; optional default agent               |
| `OPUSDESK_UPDATE_AGENT`   | `1` explicitly reinstalls/updates the agent interactively |
| `OPUSDESK_VERSION`        | A stable `vX.Y.Z` tag; default `latest`                   |
| `OPUSDESK_GITHUB_HOST`    | GitHub hostname; default `github.com`                     |
| `OPUSDESK_INSTALL_DIR`    | Destination; default `~/.local/bin`                       |
| `OPUSDESK_PROJECTS_DIR`   | Existing parent folder containing Git repositories        |
| `OPUSDESK_NONINTERACTIVE` | `1` skips prompts and integration setup                   |
| `OPUSDESK_START`          | `1` starts the daemon after setup                         |
| `OPUSDESK_DATA_DIR`       | Overrides the state and log directory                     |

The script does not change repository settings or your Git identity. Git uses your existing identity for commits. If you choose Git credential setup, the script runs `gh auth setup-git`.

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

Run `opus-desk update` or rerun the installer for updates, then run `opus-desk restart` to switch an already running daemon to the new binary. State is preserved. The daemon survives a closed terminal; it does not restart at login or after a reboot, and it is not a supervised service.

For removal, run `opus-desk stop` and remove `~/.local/bin/opus-desk` (or your custom installation path). State, logs, and retained worktrees are under `~/.local/share/prquay`; inspect them before deleting. GitHub CLI, agents, and Homebrew are managed independently and are left installed.

## Troubleshooting

- **Command not found:** add `~/.local/bin` to PATH using the instruction printed by setup, then open a new terminal.
- **Port already in use:** choose another port with `opus-desk start --port 5000`.
- **Startup failed:** inspect `~/.local/share/prquay/daemon.log` and run `opus-desk run` to see errors directly.
- **Interrupted lifecycle command:** verify no start/stop command is still running before removing a stale `daemon.lock` from the state directory.
- **Missing releases:** use the developer setup until the first reviewed release PR is merged and CI publishes its assets.
- **CLI authentication/SSO errors:** rerun the relevant provider's login or GitHub's scope refresh and authorize any required organization SSO.
- **Agent installer returns HTML:** setup refuses to execute the response. Check network/proxy access to the official install URL, then retry. Claude setup can use Homebrew on macOS; see [Anthropic's installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install#install-script-returns-html-instead-of-a-shell-script).
