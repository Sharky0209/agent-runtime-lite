import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StateStore, iso} from './state.mjs';

// Only this process owns the OS child execution and process-exit gate.
// Parent task state remains derived from the jobs; it is never set by worker PID.
export async function executeWorker(root, jobId, attemptId, {afterChildSpawn} = {}) {
  const store = new StateStore(root);
  const spec = store.update(state => {
    const job = state.jobs[jobId];
    if (!job || job.state !== 'launching' || job.attempts.at(-1)?.id !== attemptId) {
      throw Error('WORKER_ATTEMPT_NOT_CURRENT');
    }
    const attempt = job.attempts.at(-1);
    attempt.workerPid = process.pid;
    attempt.heartbeatAt = iso();
    job.state = 'running';
    job.updatedAt = iso();
    return {command: job.command, timeoutMs: job.timeoutMs};
  });
  const logs = path.join(root, '.arl', 'logs');
  fs.mkdirSync(logs, {recursive: true});
  const fd = fs.openSync(path.join(logs, jobId + '-' + attemptId + '.log'), 'a');
  const command = spec.command;
  // Persist dispatch intent before the spawn/PID-persist crash window.
  store.update(state => {
    const job = state.jobs[jobId];
    const attempt = job?.attempts.at(-1);
    if (job?.state !== 'running' || attempt?.id !== attemptId) {
      throw Error('WORKER_ATTEMPT_NOT_CURRENT');
    }
    attempt.spawnIntentAt = iso();
  });
  const child = spawn(command.exe, command.args, {
    cwd: command.cwd || root,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    shell: false
  });
  // Test seam: inject a real worker crash in the narrow spawn-before-PID-write window.
  // Normal CLI workers never supply this callback.
  afterChildSpawn?.(child);
  store.update(state => {
    const job = state.jobs[jobId];
    const attempt = job?.attempts.find(a => a.id === attemptId);
    if (attempt) attempt.childPid = child.pid || null;
  });
  let spawnError = null;
  child.on('error', error => { spawnError = error; });
  const ticker = setInterval(() => {
    try {
      store.update(state => {
        const job = state.jobs[jobId];
        const attempt = job?.attempts.at(-1);
        if (attempt?.id === attemptId && job.state === 'running') {
          attempt.heartbeatAt = iso();
        }
      });
    } catch (error) { console.error('HEARTBEAT:', error.message); }
  }, 2000);
  ticker.unref();
  let timedOut = false;
  let forceKill = null;
  const killer = spec.timeoutMs ? setTimeout(() => {
    timedOut = true;
    child.kill();
    // A child may ignore SIGTERM on POSIX; do not wait forever for close.
    forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    forceKill.unref();
  }, spec.timeoutMs) : null;
  const exit = await new Promise(resolve => {
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  if (killer) clearTimeout(killer);
  if (forceKill) clearTimeout(forceKill);
  clearInterval(ticker);
  fs.closeSync(fd);
  store.update(state => {
    const job = state.jobs[jobId];
    const attempt = job?.attempts.at(-1);
    if (!attempt || attempt.id !== attemptId) return;
    attempt.finishedAt = iso();
    attempt.exitCode = exit.code;
    attempt.signal = exit.signal || null;
    if (job.state !== 'running') return;
    job.updatedAt = iso();
    if (exit.code === 0 && !spawnError && !timedOut) {
      job.state = 'completion_candidate';
      const gate = job.gates.find(g => g.name === 'process_exit_zero');
      gate.passed = true;
      gate.evidence = 'child process exited with code 0';
    } else {
      job.state = 'failed';
      job.blockReason = timedOut ? 'PROCESS_TIMEOUT:' + spec.timeoutMs :
        (spawnError?.message || 'PROCESS_EXIT:' + String(exit.code) +
          (exit.signal ? ':' + exit.signal : ''));
      if (!job.operations.some(op => op.state === 'uncertain')) {
        for (const resource of job.resources) {
          if (state.resources[resource] === jobId) delete state.resources[resource];
        }
      }
    }
  });
  return exit;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  executeWorker(process.argv[2], process.argv[3], process.argv[4])
    .then(() => {}, error => { console.error(error); process.exitCode = 1; });
}
