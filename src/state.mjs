import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Atomic local state replacement guarded by a short-lived process lock.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const live = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const blank = () => ({version: 1, tasks: {}, jobs: {}, taskKeys: {}, jobKeys: {}, resources: {}});
export const iso = () => new Date().toISOString();

export class StateStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, '.arl');
    this.file = path.join(this.dir, 'state.json');
    this.lock = path.join(this.dir, '.lock');
  }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return blank();
      throw error;
    }
  }
  write(value) {
    fs.mkdirSync(this.dir, {recursive: true});
    const tmp = this.file + '.tmp-' + randomUUID();
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
      for (let n = 0; n < 8; n++) {
        try { fs.renameSync(tmp, this.file); return; }
        catch (error) {
          if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || n === 7) throw error;
          pause(15 * (n + 1));
        }
      }
    } finally {
      try { fs.rmSync(tmp, {force: true}); } catch {}
    }
  }
  update(fn) {
    fs.mkdirSync(this.dir, {recursive: true});
    const started = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(this.lock);
        fs.writeFileSync(path.join(this.lock, 'owner.json'), JSON.stringify({pid: process.pid}), 'utf8');
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const age = (() => {
          try { return Date.now() - fs.statSync(this.lock).mtimeMs; } catch { return 0; }
        })();
        let pid = null;
        try { pid = JSON.parse(fs.readFileSync(path.join(this.lock, 'owner.json'), 'utf8')).pid; } catch {}
        if (age > 30_000 && !live(pid)) {
          try { fs.rmSync(this.lock, {recursive: true, force: true}); continue; } catch {}
        }
        if (Date.now() - started > 5000) throw new Error('STORE_BUSY');
        pause(20);
      }
    }
    try {
      const state = this.read();
      const result = fn(state);
      this.write(state);
      return result;
    } finally {
      fs.rmSync(this.lock, {recursive: true, force: true});
    }
  }
}

export function processAlive(pid) { return live(pid); }
