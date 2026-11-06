# Security policy

Security fixes target the latest release. Older versions may require an upgrade.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/jakecyr/opus-desk/security/advisories/new). Do not post credentials, conversation contents, exploit details involving private repositories, or other sensitive data in public issues. Include the affected version, reproduction steps, impact, and a minimal example with secrets removed.

Opus Desk is a local application for a trusted user account. It binds to loopback, validates the request Host, and requires same-origin writes plus an application header. These checks do not protect against other software already running as your user. Do not expose it through a public tunnel, shared reverse proxy, or LAN listener.

The application can run agents, change local repositories, and act on GitHub using your CLI credentials. Agent permissions currently default to unrestricted local access; review Settings before starting tasks. Auto mode prepares local changes and draft reviews for an explicit publishing action. This workflow policy does not restrict the shell or network access of an unrestricted agent. Treat repository, issue, PR, and conversation text as untrusted input.

Release archives contain a bundled Node runtime. Releases include checksums and third-party license notices. macOS binaries are ad hoc signed, not notarized. No independent artifact-signing guarantee is currently provided.
