import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localOptions } from './local.js';

async function health(record) {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    const body = await response.json();
    return (
      body.ok === true &&
      body.pid === record.pid &&
      body.instance === record.instance
    );
  } catch {
    return false;
  }
}

export async function runningDaemon() {
  const dir =
    process.env.OPUSDESK_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'prquay');
  try {
    const record = JSON.parse(
      await fs.readFile(path.join(dir, 'daemon.pid'), 'utf8'),
    );
    return record?.instance && (await health(record)) ? record : null;
  } catch {
    return null;
  }
}

export async function daemon(action, runtime) {
  const dir =
    process.env.OPUSDESK_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'prquay');
  const pidfile = path.join(dir, 'daemon.pid');
  const logfile = path.join(dir, 'daemon.log');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'daemon.lock');
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Another daemon command is running. If it was interrupted, remove ${lock} and retry.`,
        { cause: error },
      );
    throw error;
  }
  try {
    let record;
    try {
      record = JSON.parse(await fs.readFile(pidfile, 'utf8'));
    } catch {
      /* No daemon record. */
    }
    const running = record?.instance && (await health(record));
    const url = record ? `http://${record.hostname}:${record.port}` : '';
    if (action === 'status') {
      console.log(
        running
          ? `Running (PID ${record.pid}) at ${url}\nLog: ${logfile}`
          : 'Stopped',
      );
      return;
    }
    if (action === 'start' && running) {
      console.log(`Already running (PID ${record.pid}) at ${url}`);
      return;
    }
    if (action === 'stop' || action === 'restart') {
      if (running) {
        process.kill(record.pid, 'SIGTERM');
        for (let i = 0; i < 60; i++) {
          await delay(100);
          try {
            process.kill(record.pid, 0);
          } catch {
            break;
          }
          if (i === 59)
            throw new Error(
              `Daemon PID ${record.pid} did not stop; inspect ${logfile}`,
            );
        }
        console.log(`Stopped PID ${record.pid}`);
      } else if (action === 'stop') console.log('Already stopped');
      await fs.rm(pidfile, { force: true });
      if (action === 'stop') return;
    }
    if (!['start', 'restart'].includes(action))
      throw new Error(`Unknown daemon action: ${action}`);
    const local = localOptions({
      port:
        runtime.port ??
        process.env.PORT ??
        (action === 'restart' ? record?.port : undefined),
      hostname:
        runtime.hostname ??
        process.env.OPUSDESK_HOSTNAME ??
        (action === 'restart' ? record?.hostname : undefined),
    });
    const instance = randomUUID();
    const log = await fs.open(logfile, 'a', 0o600);
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          ...(runtime.entry ? [runtime.entry] : []),
          'run',
          '--port',
          String(local.port),
          '--hostname',
          local.hostname,
        ],
        {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          cwd: os.homedir(),
          env: { ...process.env, OPUSDESK_INSTANCE: instance },
        },
      );
    } finally {
      await log.close();
    }
    let failure;
    child.on('error', (error) => {
      failure = error;
    });
    child.unref();
    record = { pid: child.pid, instance, ...local };
    for (let i = 0; i < 100; i++) {
      if (failure || child.exitCode !== null) break;
      if (await health(record)) {
        await fs.writeFile(pidfile, JSON.stringify(record), { mode: 0o600 });
        console.log(
          `Started Opus Desk (PID ${record.pid}) at http://${local.hostname}:${local.port}\nLog: ${logfile}`,
        );
        return;
      }
      await delay(100);
    }
    if (child.pid && child.exitCode === null) child.kill('SIGTERM');
    throw new Error(
      `Daemon failed to start${failure ? `: ${failure.message}` : ''}. Inspect ${logfile}`,
    );
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}
