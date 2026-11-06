import fs from 'node:fs/promises';
import { startServer } from './app.js';
import { daemon, runningDaemon } from './daemon.js';
import { localOptions } from './local.js';
import { version } from './version.js';
import { loadState, saveState } from './core.js';

export function parseArgs(args) {
  const options = {};
  const [action = 'help', ...rest] = args;
  if (['--help', '-h', 'help'].includes(action))
    return { action: 'help', options };
  if (['--version', '-v', 'version'].includes(action))
    return { action: 'version', options };
  if (
    !['start', 'stop', 'restart', 'status', 'run', 'configure'].includes(action)
  )
    throw new Error(`Unknown command: ${action}. Run opus-desk --help.`);
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (
      !['--port', '--hostname', '--agent', '--projects'].includes(name) ||
      !rest[i + 1] ||
      rest[i + 1].startsWith('--')
    ) {
      throw new Error(`Invalid option: ${name}. Run opus-desk --help.`);
    }
    const allowed =
      action === 'configure'
        ? ['--agent', '--projects']
        : ['start', 'restart', 'run'].includes(action)
          ? ['--port', '--hostname']
          : [];
    if (!allowed.includes(name))
      throw new Error(`${action} does not accept ${name}`);
    options[name.slice(2)] = rest[i + 1];
  }
  return { action, options };
}

export async function runCli(args, runtime) {
  const { action, options } = parseArgs(args);
  if (action === 'help') {
    console.log(`Opus Desk ${version}

Usage: opus-desk <command> [options]

  start     Start a detached local daemon
  stop      Stop the daemon
  restart   Stop and start the daemon
  status    Show the daemon URL, PID, and log path
  run       Serve in the foreground (Ctrl-C to stop)
  configure Set --agent codex|claude and/or --projects <parent-directory>

Options for start, restart, and run:
  --port <number>       Listening port (default: 4317; also PORT)
  --hostname <name>     Display/allow a loopback name (also OPUSDESK_HOSTNAME)

  opus-desk start --hostname opus-desk.localhost
  opus-desk --version

State: OPUSDESK_DATA_DIR or ~/.local/share/prquay
The daemon survives a closed terminal; it does not start at login.`);
    return;
  }
  if (action === 'version') {
    console.log(version);
    return;
  }
  if (action === 'configure') {
    if (options.agent && !['codex', 'claude'].includes(options.agent))
      throw new Error('Agent must be codex or claude');
    if (options.projects && !(await fs.stat(options.projects)).isDirectory())
      throw new Error('Projects path must be a directory');
    const patch = {};
    if (options.agent) patch.defaultAgent = options.agent;
    if (options.projects) patch.root = await fs.realpath(options.projects);
    const active = await runningDaemon();
    if (active) {
      const response = await fetch(
        `http://127.0.0.1:${active.port}/api/settings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-prquay': 'local' },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error || 'Configuration update failed',
        );
      console.log('Configuration saved to the running daemon.');
    } else {
      const state = await loadState();
      Object.assign(state.settings, patch);
      await saveState(state);
      console.log('Configuration saved.');
    }
    return;
  }
  if (action === 'run') {
    const local = localOptions(options);
    const staticRoot =
      process.env.OPUSDESK_STATIC_ROOT ||
      (typeof runtime.staticRoot === 'function'
        ? await runtime.staticRoot()
        : runtime.staticRoot);
    await fs.access(`${staticRoot}/index.html`).catch(() => {
      throw new Error('Dashboard assets are missing. Run npm run build first.');
    });
    await startServer({ ...local, staticRoot });
    return;
  }
  await daemon(action, { ...runtime, ...options });
}
