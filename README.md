# Opus Desk

[![CI](https://github.com/jakecyr/opus-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/jakecyr/opus-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Your local dashboard for GitHub pull requests, issues, and Codex or Claude Code sessions. Pick up conversations, review PRs, and run agent workflows from one place.

## Get started

On macOS or Linux, run this in your terminal:

```sh
curl -fsSL https://github.com/jakecyr/opus-desk/releases/latest/download/install.sh | bash
```

The installer verifies and installs Opus Desk first. You can then choose whether to configure GitHub, install or sign in to a coding agent, add the command to your PATH, and start the app. Each integration can be set up later. Existing enterprise CLI configurations can be used without running the standard sign-in flows.

Run `opus-desk update` to install the latest release, then `opus-desk restart` to update a running daemon. Rerunning the installer also installs the latest release.

Open **http://127.0.0.1:4317**. No Node.js installation is needed. Agent features require a compatible, configured Codex or Claude Code CLI and access to its provider.

Release downloads become available after the first release PR is merged and CI publishes the binaries. Until then, use the [developer setup](CONTRIBUTING.md#development).

## Everyday commands

```sh
opus-desk start
opus-desk status
opus-desk stop
opus-desk restart
```

It keeps running when you close the terminal. To use a friendly local URL:

```sh
opus-desk restart --hostname opus-desk.localhost
```

Then open **http://opus-desk.localhost:4317**. The server stays on loopback. Most modern browsers resolve `.localhost` names locally; use the IP address if yours does not. A hostname does not remove the port.

The default port is `4317`. To use a different port, specify it when starting or restarting:

```sh
opus-desk start --port 5000
# Or, for a foreground run:
opus-desk run --port 5000
```

Then open **http://127.0.0.1:5000**. For a source checkout, use `npm start -- --port 5000` instead. You can also set the `PORT` environment variable.

## Learn more

- [Installation, updates, and troubleshooting](docs/installation.md)
- [Features, permissions, and current limitations](docs/usage.md)
- [Development and contributing](CONTRIBUTING.md)
- [How reviewed PRs become releases](docs/releases.md)
- [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [MIT license](LICENSE)

Opus Desk uses your existing CLI authentication and stores its state on your machine. Agents currently default to unrestricted local access; select sandbox mode in Settings if needed. Auto mode is off by default. It prepares local commits and draft reviews; publishing is queued for your approval on Focus. Review [permissions and behavior](docs/usage.md) before starting agents.
