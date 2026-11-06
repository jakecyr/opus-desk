import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex } from './codex.js';
import { runClaude } from './claude.js';
import { statePath } from './core.js';
import { collectPublication, publishPrepared } from './publications.js';

const directory = path.join(path.dirname(statePath), 'agents');
const socketPath = path.join(
  os.tmpdir(),
  `opusdesk-${process.getuid?.() || 0}-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}.sock`,
);
const recordPath = path.join(directory, 'host.json');

// The host owns the CLI pipes, so closing the dashboard cannot close agent stdin.
export async function startAgentHost() {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const codex = new Codex(),
    clients = new Set(),
    active = new Set(),
    completed = new Map();
  const tasks = {};
  const write = (socket, message) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  };
  function emit(event) {
    if (event.method === 'connection/closed') {
      for (const id of [...active].filter((id) => !id.startsWith('claude:')))
        emit({
          method: 'turn/completed',
          params: {
            threadId: id,
            status: 'failed',
            error: 'Codex disconnected. Inspect the chat before retrying.',
          },
        });
    }
    if (event.method === 'turn/completed') {
      active.delete(event.params.threadId);
      completed.set(event.params.threadId, event);
      if (completed.size > 1000)
        completed.delete(completed.keys().next().value);
      void finish(event).catch((e) => console.error(e));
    }
    for (const client of clients) write(client, { event });
  }
  async function persist(task) {
    const file = path.join(directory, task.key + '.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(task), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
    emit({ method: 'preparation/updated', params: { task: { ...task } } });
  }
  async function finish(event) {
    const task = Object.values(tasks).find(
      (t) => t.id === event.params.threadId && t.status === 'running',
    );
    if (!task) return;
    task.status = 'collecting';
    await persist(task);
    try {
      const status = event.params.turn?.status || event.params.status;
      if (status !== 'completed')
        throw Error(event.params.error || 'Agent did not finish');
      Object.assign(task, await collectPublication(task));
      if (
        task.kind === 'ci' &&
        task.pushOnCompletion &&
        !task.auto &&
        task.status === 'pending'
      ) {
        task.status = 'publishing';
        await persist(task);
        const result = await publishPrepared({ ...task, status: 'pending' });
        task.status = 'published';
        task.publishedAt = Date.now();
        task.publishedUrl = result.url;
      }
    } catch (error) {
      task.status = 'failed';
      task.error = error.message;
    }
    await persist(task);
  }
  codex.on('event', emit);
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    createInterface({ input: socket }).on('line', async (line) => {
      let message;
      try {
        message = JSON.parse(line);
        const { method, params = {} } = message;
        let result;
        if (method === 'host/snapshot')
          result = {
            active: [...active],
            completed: [...completed.values()],
            tasks,
            requests: [...codex.requests.values()],
            pid: process.pid,
          };
        else if (method === 'host/register') {
          tasks[params.key] = params;
          await persist(params);
          result = {};
        } else if (method === 'host/respond') {
          codex.respond(params.id, params.result);
          result = {};
        } else if (method === 'host/claude') {
          const id = 'claude:' + params.id;
          if (active.has(id))
            throw Error('This chat already has an active turn');
          active.add(id);
          completed.delete(id);
          runClaude(params, emit);
          result = { id };
        } else {
          await codex.start();
          if (method === 'turn/start') {
            if (active.has(params.threadId))
              throw Error('This chat already has an active turn');
            active.add(params.threadId);
            completed.delete(params.threadId);
          }
          try {
            result = await codex.call(method, params);
          } catch (error) {
            if (method === 'turn/start') active.delete(params.threadId);
            throw error;
          }
        }
        write(socket, { id: message.id, result });
      } catch (error) {
        write(socket, { id: message?.id, error: error.message });
      }
    });
  });
  for (const name of await fs.readdir(directory)) {
    if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
    const task = JSON.parse(
      await fs.readFile(path.join(directory, name), 'utf8'),
    );
    if (['running', 'collecting', 'publishing'].includes(task.status)) {
      task.status = 'failed';
      task.error =
        'The agent host was interrupted. Inspect the chat and GitHub before retrying.';
      await persist(task);
    }
    tasks[task.key] = task;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  await fs.writeFile(
    recordPath,
    JSON.stringify({ pid: process.pid, socketPath }),
    { mode: 0o600 },
  );
}

export class AgentClient extends EventEmitter {
  constructor(runtime = { entry: process.argv[1] }) {
    super();
    this.runtime = runtime;
    this.pending = new Map();
    this.requests = new Map();
    this.active = new Set();
    this.next = 1;
  }
  start() {
    this.ready ??= this.connect().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }
  async connect() {
    const open = () =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.removeListener('error', reject);
          resolve(socket);
        });
      });
    let socket;
    try {
      socket = await open();
    } catch {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      // Only remove a stale socket after a failed connection. Concurrent starters
      // are serialized by this lock; the winner owns the detached host.
      let lock;
      try {
        lock = await fs.open(path.join(directory, 'start.lock'), 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(
          await fs
            .readFile(path.join(directory, 'start.lock'), 'utf8')
            .catch(() => ''),
        );
        if (owner) {
          try {
            process.kill(owner, 0);
          } catch (error) {
            if (error.code === 'ESRCH') {
              await fs.rm(path.join(directory, 'start.lock'), { force: true });
              return this.connect();
            }
          }
        }
      }
      if (lock) {
        try {
          await lock.writeFile(String(process.pid));
          try {
            socket = await open();
          } catch {
            await fs.rm(socketPath, { force: true });
            const log = await fs.open(
              path.join(directory, 'host.log'),
              'a',
              0o600,
            );
            try {
              const child = spawn(
                process.execPath,
                [
                  ...(this.runtime.entry ? [this.runtime.entry] : []),
                  'agent-host',
                ],
                {
                  detached: true,
                  stdio: ['ignore', log.fd, log.fd],
                  env: process.env,
                },
              );
              await new Promise((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
              });
              child.unref();
            } finally {
              await log.close();
            }
          }
          for (let i = 0; !socket && i < 100; i++) {
            await delay(50);
            try {
              socket = await open();
            } catch {}
          }
        } finally {
          await lock.close();
          await fs.rm(path.join(directory, 'start.lock'), { force: true });
        }
      } else {
        for (let i = 0; !socket && i < 100; i++) {
          await delay(50);
          try {
            socket = await open();
          } catch {}
        }
      }
    }
    if (!socket)
      throw Error(
        'Could not connect to the background agent host. Check agents/host.log.',
      );
    this.socket = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      this.ready = null;
      for (const request of this.pending.values())
        request.reject(Error('Background agent host disconnected'));
      this.pending.clear();
      this.emit('event', { method: 'connection/closed' });
    });
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.event) {
        const event = message.event;
        if (event.id != null && event.method)
          this.requests.set(String(event.id), event);
        if (event.method === 'turn/completed')
          this.active.delete(event.params.threadId);
        this.emit('event', event);
      } else {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (request)
          message.error
            ? request.reject(Error(message.error))
            : request.resolve(message.result);
      }
    });
    const snapshot = await this.request('host/snapshot');
    this.active = new Set(snapshot.active);
    this.requests = new Map(snapshot.requests.map((r) => [String(r.id), r]));
    this.emit('snapshot', snapshot);
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async call(method, params) {
    await this.start();
    if (method === 'turn/start') this.active.add(params.threadId);
    try {
      return await this.request(method, params);
    } catch (error) {
      if (method === 'turn/start') this.active.delete(params.threadId);
      throw error;
    }
  }
  async respond(id, result) {
    await this.call('host/respond', { id, result });
    this.requests.delete(String(id));
  }
  async runClaude(options) {
    await this.start();
    const id = 'claude:' + options.id;
    this.active.add(id);
    try {
      const result = await this.request('host/claude', options);
      return result.id;
    } catch (error) {
      this.active.delete(id);
      throw error;
    }
  }
  disconnect() {
    this.socket?.destroy();
  }
}
