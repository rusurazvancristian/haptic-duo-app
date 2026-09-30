// Nordic UART Service transport for the Haptic Duo line protocol.
// One command in flight at a time; replies are paired to it, telemetry (`T ...`) is routed separately.
import { parseTelemetry } from './protocol.js';

export const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
};

const MAX_LINE = 127;
const IDLE_MS = 300; // end of an unterminated multi-line reply (`help` only; `status` ends with `OK status`)

function classify(cmd) {
  const w = cmd.trim().split(/\s+/);
  if (w[0] === 'status') return 'status';
  if (w[0] === 'help') return 'multi';
  if (w[0] === 'profile' && w[1] === 'list') return 'list';
  return 'ok';
}

function defaultTimeout(cmd) {
  const w = cmd.trim().split(/\s+/)[0];
  if (w === 'status') return 2000;
  return w === 'config' ? 9000 : 4000; // config prepares the motor, about 1 s
}

export class Link extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.chunk = 20; // ATT default MTU 23 - 3; Web Bluetooth cannot read the negotiated MTU
    this.open = false;
    this.queue = [];
    this.cur = null;
    this.buf = '';
    this.dec = new TextDecoder();
    this.enc = new TextEncoder();
    this.writes = Promise.resolve();
    this._onNotify = (e) => this._notify(e.target.value);
    this._onDisc = () => this._lost(false);
  }

  get name() {
    return this.device ? this.device.name || 'Haptic Duo' : '';
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS.service] }] });
    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisc);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisc);
    await this._open();
  }

  async reconnect() {
    if (!this.device) return this.connect();
    await this._open();
  }

  async _open() {
    this.buf = '';
    this.dec = new TextDecoder();
    try {
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(NUS.service);
      this.rx = await svc.getCharacteristic(NUS.rx);
      this.tx = await svc.getCharacteristic(NUS.tx);
      this.tx.addEventListener('characteristicvaluechanged', this._onNotify);
      await this.tx.startNotifications();
    } catch (e) {
      try {
        this.device.gatt.disconnect();
      } catch {
        /* already down */
      }
      this.rx = this.tx = null;
      throw e;
    }
    this.open = true;
    this.emit('connected');
  }

  disconnect() {
    if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    this._lost(true);
  }

  _lost(byUser) {
    if (!this.open) return;
    this.open = false;
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.rx = this.tx = null;
    this.buf = '';
    const err = new Error('Conexiune pierdută');
    const pending = [...(this.cur ? [this.cur] : []), ...this.queue];
    this.queue = [];
    for (const item of pending) this._finish(item, err);
    this.emit('disconnected', { byUser });
  }

  // Resolves with the reply lines; rejects on ERR, timeout or lost connection.
  // priority: jumps the queue and flushes any half-written line on the device first (used by DISARM).
  send(cmd, { timeout, priority = false } = {}) {
    if (!this.open) return Promise.reject(new Error('Neconectat'));
    if (cmd.length > MAX_LINE) return Promise.reject(new Error('Comandă prea lungă (max 127 caractere)'));
    return new Promise((resolve, reject) => {
      const item = {
        cmd,
        kind: classify(cmd),
        timeout: timeout ?? defaultTimeout(cmd),
        priority,
        resolve,
        reject,
        lines: [],
        need: null,
        got: 0,
        timer: null,
        idle: null,
        done: false,
      };
      if (priority) {
        if (this.cur) this._finish(this.cur, new Error('Întrerupt de o comandă prioritară'));
        this.queue.unshift(item);
      } else {
        this.queue.push(item);
      }
      this._pump();
    });
  }

  async _pump() {
    if (this.cur || !this.queue.length || !this.open) return;
    const item = this.queue.shift();
    this.cur = item;
    this.emit('tx', item.cmd);
    try {
      await this._write((item.priority ? '\n' : '') + item.cmd + '\n');
    } catch (e) {
      this._finish(item, e);
      return;
    }
    if (this.cur === item && !item.done) {
      item.timer = setTimeout(
        () => this._finish(item, new Error(`Fără răspuns la „${item.cmd}” (timeout)`)),
        item.timeout,
      );
    }
  }

  _write(text) {
    const bytes = this.enc.encode(text);
    const rx = this.rx;
    const job = this.writes.then(async () => {
      for (let i = 0; i < bytes.length; i += this.chunk) {
        const part = bytes.slice(i, i + this.chunk);
        if (rx.writeValueWithResponse) await rx.writeValueWithResponse(part);
        else await rx.writeValue(part);
      }
    });
    this.writes = job.catch(() => {});
    return job;
  }

  _finish(item, err) {
    if (item.done) return;
    item.done = true;
    clearTimeout(item.timer);
    clearTimeout(item.idle);
    if (this.cur === item) this.cur = null;
    if (err) item.reject(err);
    else item.resolve(item.lines);
    queueMicrotask(() => this._pump());
  }

  _notify(view) {
    this.buf += this.dec.decode(view, { stream: true });
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this._line(line.trim());
    }
    if (this.buf.length > 1024) this.buf = '';
  }

  _line(line) {
    if (/^T\s/.test(line)) {
      const t = parseTelemetry(line);
      if (t) this.emit('telemetry', t);
      this.emit('telemetry-line', line);
      return;
    }
    this.emit('line', line);
    const it = this.cur;
    if (!it || it.done) return this.emit('event', line);
    // `OK armed` completes an earlier `arm` (which was already answered by `OK aligning`).
    if (line === 'OK armed' && it.cmd !== 'arm') return this.emit('event', line);
    const isErr = /^ERR\b/.test(line);
    if (it.kind === 'status') {
      if (isErr) return this._finish(it, Object.assign(new Error(line), { reply: line }));
      if (line === 'OK status') return this._finish(it, null);
      it.lines.push(line);
    } else if (it.kind === 'multi') {
      if (isErr) return this._finish(it, Object.assign(new Error(line), { reply: line }));
      it.lines.push(line);
      clearTimeout(it.idle);
      it.idle = setTimeout(() => this._finish(it, null), IDLE_MS);
    } else if (it.kind === 'list') {
      if (isErr) return this._finish(it, Object.assign(new Error(line), { reply: line }));
      const m = /^OK profiles\s+(\d+)/.exec(line);
      if (m) {
        it.need = Number(m[1]);
        it.lines.push(line);
        if (it.need === 0) this._finish(it, null);
      } else if (/^P\s/.test(line) && it.need !== null) {
        it.lines.push(line);
        if (++it.got >= it.need) this._finish(it, null);
      } else {
        this.emit('event', line);
      }
    } else if (/^OK\b/.test(line)) {
      it.lines.push(line);
      this._finish(it, null);
    } else if (isErr) {
      this._finish(it, Object.assign(new Error(line), { reply: line }));
    } else {
      this.emit('event', line);
    }
  }
}
