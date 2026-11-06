import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class Codex extends EventEmitter {
  constructor() { super(); this.next = 1; this.pending = new Map(); this.requests = new Map(); }
  async start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const p = this.proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      p.once('error', reject);
      p.stderr.on('data', () => {});
      p.on('exit', () => { for (const q of this.pending.values()) q.reject(new Error('Codex app-server stopped')); this.pending.clear(); this.ready = null; this.emit('event', { method: 'connection/closed' }); });
      createInterface({ input: p.stdout }).on('line', line => { try { this.receive(JSON.parse(line)); } catch {} });
      this.call('initialize', { clientInfo: { name: 'prquay', title: 'PR Quay', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(() => { this.write({ method: 'initialized' }); resolve(); }, reject);
    });
    return this.ready;
  }
  write(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  call(method, params = {}) { const id = this.next++; return new Promise((resolve, reject) => { this.pending.set(id, {resolve,reject}); this.write({id, method, params}); }); }
  receive(msg) {
    if (msg.id != null && !msg.method) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } return; }
    if (msg.method && msg.id != null) this.requests.set(String(msg.id), msg);
    this.emit('event', msg);
  }
  respond(id, result) { const req = this.requests.get(String(id)); if (!req) throw new Error('This request is no longer active'); this.requests.delete(String(id)); this.write({ id: req.id, result }); }
}
