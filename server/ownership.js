import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function matchingTerminal(session, terminals) {
  if (!session?.cwd) return false;
  const expected = session.agent === 'claude' ? 'claude' : 'codex';
  return terminals.some((p) => p.agent === expected && p.cwd === session.cwd);
}
export async function terminalSessions() {
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,tty=,comm='], {
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const processes = stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
      .filter(Boolean)
      .filter(
        (m) =>
          !m[2].includes('?') &&
          ['codex', 'claude'].includes(m[3].split('/').pop()),
      )
      .map((m) => ({ pid: m[1], agent: m[3].split('/').pop() }));
    if (!processes.length) return { terminals: [], available: true };
    if (process.platform === 'linux') {
      const terminals = await Promise.all(
        processes.map(async (p) => {
          try {
            return { ...p, cwd: await fs.realpath(`/proc/${p.pid}/cwd`) };
          } catch {
            return null;
          }
        }),
      );
      return { terminals: terminals.filter(Boolean), available: true };
    }
    if (process.platform !== 'darwin')
      return { terminals: [], available: false };
    const { stdout: open } = await exec(
      'lsof',
      [
        '-n',
        '-a',
        '-p',
        processes.map((p) => p.pid).join(','),
        '-d',
        'cwd',
        '-F',
        'pn',
      ],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    let pid = '';
    const paths = new Map();
    for (const line of open.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1);
      else if (line.startsWith('n/')) paths.set(pid, line.slice(1));
    }
    const terminals = await Promise.all(
      processes.map(async (p) => {
        const cwd = paths.get(p.pid);
        if (!cwd) return null;
        return { ...p, cwd: await fs.realpath(cwd).catch(() => cwd) };
      }),
    );
    return { terminals: terminals.filter(Boolean), available: true };
  } catch {
    return { terminals: [], available: false };
  }
}
export async function externalUse(session) {
  if (!session?.cwd) return { blocked: false, available: false };
  const cwd = await fs.realpath(session.cwd).catch(() => session.cwd);
  const scan = await terminalSessions();
  return {
    blocked: matchingTerminal({ ...session, cwd }, scan.terminals),
    available: scan.available,
  };
}
