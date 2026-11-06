import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { version } from './version.js';

export class Codex extends EventEmitter {
  constructor({ spawnProcess = spawn } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.next = 1;
    this.pending = new Map();
    this.requests = new Map();
  }
  start() {
    if (this.ready) return this.ready;
    let resolveReady, rejectReady;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const ready = this.ready;
    let p;
    const disconnect = (error) => {
      if (p && this.proc !== p) return;
      this.proc = null;
      this.ready = null;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.requests.clear();
      rejectReady(error);
      if (p && p.exitCode === null && !p.killed) p.kill('SIGTERM');
      this.emit('event', { method: 'connection/closed' });
    };
    try {
      p = this.proc = this.spawnProcess('codex', ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      p.once('error', disconnect);
      // A CLI can close its pipe before exiting. Handle EPIPE on the stream
      // itself so a missing/broken agent cannot crash the dashboard process.
      p.stdin.on('error', disconnect);
      p.stdout.on('error', disconnect);
      p.stderr.on('error', disconnect);
      p.stderr.on('data', () => {});
      p.once('exit', () => disconnect(new Error('Codex app-server stopped')));
      createInterface({ input: p.stdout })
        .on('error', disconnect)
        .on('line', (line) => {
          if (this.proc !== p) return;
          try {
            this.receive(JSON.parse(line));
          } catch {}
        });
      this.call('initialize', {
        clientInfo: { name: 'prquay', title: 'Opus Desk', version },
        capabilities: { experimentalApi: true },
      })
        .then(() => {
          if (this.proc !== p) return;
          this.write({ method: 'initialized' });
          resolveReady();
        })
        .catch(disconnect);
    } catch (error) {
      disconnect(error);
    }
    return ready;
  }
  write(obj) {
    const input = this.proc?.stdin;
    if (!input || input.destroyed || input.writableEnded) {
      throw new Error('Codex app-server is not connected');
    }
    input.write(JSON.stringify(obj) + '\n');
  }
  call(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  receive(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(msg.error.message))
          : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id != null) this.requests.set(String(msg.id), msg);
    this.emit('event', msg);
  }
  respond(id, result) {
    const req = this.requests.get(String(id));
    if (!req) throw new Error('This request is no longer active');
    this.requests.delete(String(id));
    this.write({ id: req.id, result });
  }
}
