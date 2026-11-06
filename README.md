# Opus Desk

[![CI](https://github.com/jakecyr/opus-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/jakecyr/opus-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Your local dashboard for GitHub pull requests, issues, and Codex or Claude Code sessions. Pick up conversations, review PRs, and run agent workflows from one place.

## Get started

On macOS or Linux, run this in your terminal:

```sh
curl -fsSL https://github.com/jakecyr/opus-desk/releases/latest/download/install.sh | bash
```

The interactive installer:

1. Installs or updates Git and GitHub CLI using Homebrew, and guides GitHub sign-in with the required permissions.
2. Lets you choose Codex or Claude Code, installs its latest native release, and guides sign-in.
3. Installs the verified Opus Desk binary, helps configure PATH, asks where your projects live, and offers to start it.

Open **http://127.0.0.1:4317**. No Node.js installation is needed. You need an account with access to your chosen agent; provider usage follows your plan or API billing.

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

## Learn more

- [Installation, updates, and troubleshooting](docs/installation.md)
- [Features, permissions, and current limitations](docs/usage.md)
- [Development and contributing](CONTRIBUTING.md)
- [How reviewed PRs become releases](docs/releases.md)
- [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [MIT license](LICENSE)

Opus Desk uses your existing CLI authentication and stores its state on your machine. Agents currently default to unrestricted local access; select sandbox mode in Settings if needed. Auto mode is off by default. It prepares local commits and draft reviews; publishing is queued for your approval on Focus. Review [permissions and behavior](docs/usage.md) before starting agents.
