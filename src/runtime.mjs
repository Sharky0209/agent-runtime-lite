import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {StateStore, iso, processAlive} from './state.mjs';

const fail = (message) => { throw new Error(message); };
const id = (prefix) => prefix + '-' + randomUUID();
const copy = (value) => JSON.parse(JSON.stringify(value));
const unknownEffects = (job) => job.operations.some(op => op.state === 'uncertain');
const childDispatchUncertain = (job) => {
  const attempt = job.attempts.at(-1);
  return !!(attempt?.spawnIntentAt && !attempt.childPid && !attempt.finishedAt);
};
const releaseResources = (state, job) => {
  for (const resource of job.resources) {
    if (state.resources[resource] === job.id) delete state.resources[resource];
  }
};
const commandShape = (command) => {
  if (!command || typeof command.exe !== 'string' || !command.exe.trim()) fail('COMMAND_EXE_REQUIRED');
  if (!Array.isArray(command.args) || !command.args.every(v => typeof v === 'string')) fail('COMMAND_ARGS_REQUIRED');
  if (command.cwd != null && typeof command.cwd !== 'string') fail('COMMAND_CWD_INVALID');
  return {exe: command.exe, args: [...command.args], ...(command.cwd ? {cwd: command.cwd} : {})};
};
const checkJob = (state, jobId) => state.jobs[jobId] || fail('JOB_NOT_FOUND');
const checkTask = (state, taskId) => state.tasks[taskId] || fail('TASK_NOT_FOUND');
const touch = (row) => { row.updatedAt = iso(); return row; };

export function deriveTask(task, jobs) {
  if (task.cancelledAt) return 'cancelled';
  const required = jobs.filter(j => j.required);
  if (task.needsInput) return 'waiting_user';
  if (required.some(j => ['failed','blocked','cancelled'].includes(j.state))) return 'blocked';
  if (required.some(j => j.state === 'completion_candidate')) return 'validating';
  if (required.some(j => ['queued','launching','running'].includes(j.state))) return 'running';
  if (required.length && required.every(j => j.state === 'completed')) return 'completed';
  return 'active';
}

export class Runtime {
  constructor(root = process.cwd()) {
    this.root = path.resolve(root);
    this.store = new StateStore(this.root);
  }
  accept({key, title, goal = ''}) {
    if (!key || !title) fail('TASK_KEY_AND_TITLE_REQUIRED');
    return this.store.update(state => {
      const existing = state.taskKeys[key];
      if (existing) return {deduplicated: true, task: copy(checkTask(state, existing))};
      const now = iso();
      const task = {id: id('task'), kind: 'control_task', key, title, goal,
        state: 'active', needsInput: false, checkpoint: null, createdAt: now, updatedAt: now};
      state.tasks[task.id] = task;
      state.taskKeys[key] = task.id;
      return {deduplicated: false, task: copy(task)};
    });
  }
  submit({taskId, key, command, required = true, gates = [], resources = [],
    resume = 'manual', readOnly = false, maxRestarts = 0, timeoutMs = 0}) {
    if (!key) fail('JOB_KEY_REQUIRED');
    const normalized = commandShape(command);
    if (!['manual', 'auto_safe'].includes(resume)) fail('RESUME_POLICY_INVALID');
    if (resume === 'auto_safe' && !readOnly) fail('AUTO_RECOVERY_REQUIRES_READ_ONLY');
    if (!Array.isArray(resources) || !resources.every(v => typeof v === 'string' && v.trim())) fail('RESOURCES_INVALID');
    if (!Array.isArray(gates) || !gates.every(v => typeof v === 'string' && v.trim() && v !== 'process_exit_zero')) fail('GATES_INVALID');
    if (new Set(gates).size !== gates.length) fail('DUPLICATE_GATE');
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0) fail('JOB_LIMIT_INVALID');
    const immutable = {command: normalized, required: !!required, readOnly: !!readOnly,
      resume, maxRestarts, timeoutMs, resources: [...new Set(resources)], gates};
    return this.store.update(state => {
      checkTask(state, taskId);
      const lookup = JSON.stringify([taskId,key]);
      if (state.jobKeys[lookup]) {
        const previous = checkJob(state, state.jobKeys[lookup]);
        const previousImmutable = {command: previous.command, required: previous.required,
          readOnly: previous.readOnly, resume: previous.resume, maxRestarts: previous.maxRestarts,
          timeoutMs: previous.timeoutMs, resources: previous.resources,
          gates: previous.gates.filter(g => g.name !== 'process_exit_zero').map(g => g.name)};
        if (JSON.stringify(previousImmutable) !== JSON.stringify(immutable)) fail('JOB_KEY_PAYLOAD_CONFLICT');
        return {deduplicated: true, job: copy(previous)};
      }
      const now = iso();
      const job = {id: id('job'), kind: 'runtime_job', taskId, key, command: normalized,
        required: !!required, readOnly: !!readOnly, resume, maxRestarts, timeoutMs,
        resources: [...new Set(resources)], operations: [],
        gates: [{name: 'process_exit_zero', passed: false, evidence: null},
          ...gates.map(name => ({name, passed: false, evidence: null}))],
        attempts: [], state: 'queued', createdAt: now, updatedAt: now, blockReason: null};
      state.jobs[job.id] = job;
      state.jobKeys[lookup] = job.id;
      return {deduplicated: false, job: copy(job)};
    });
  }
  status({taskId, jobId} = {}) {
    const state = this.store.read();
    if (jobId) return {job: copy(checkJob(state, jobId))};
    if (taskId) {
      const task = checkTask(state, taskId);
      const jobs = Object.values(state.jobs).filter(j => j.taskId === taskId);
      return {task: {...copy(task), state: deriveTask(task, jobs)}, jobs: copy(jobs)};
    }
    return {tasks: Object.values(state.tasks).map(task => {
      const jobs = Object.values(state.jobs).filter(j => j.taskId === task.id);
      return {...copy(task), state: deriveTask(task, jobs)};
    }), jobs: copy(Object.values(state.jobs))};
  }
  checkpoint({taskId, step, note = ''}) {
    if (!step) fail('CHECKPOINT_STEP_REQUIRED');
    return this.store.update(state => {
      const task = checkTask(state, taskId);
      touch(task).checkpoint = {step, note, at: iso()};
      return copy(task);
    });
  }
  beginOperation({jobId, key}) {
    if (!key) fail('OPERATION_KEY_REQUIRED');
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (!['running','completion_candidate'].includes(job.state)) fail('JOB_NOT_ACTIVE');
      const existing = job.operations.find(v => v.key === key);
      if (existing) return {deduplicated: true, operation: copy(existing)};
      const operation = {key, state: 'uncertain', at: iso(), evidence: null};
      job.operations.push(operation);
      touch(job);
      return {deduplicated: false, operation: copy(operation)};
    });
  }
  settleOperation({jobId, key, outcome, evidence}) {
    if (!['confirmed','aborted'].includes(outcome)) fail('OPERATION_OUTCOME_INVALID');
    if (!evidence || !String(evidence).trim()) fail('OPERATION_EVIDENCE_REQUIRED');
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      const op = job.operations.find(v => v.key === key);
      if (!op) fail('OPERATION_NOT_FOUND');
      if (op.state !== 'uncertain' && op.state !== outcome) fail('OPERATION_ALREADY_SETTLED');
      op.state = outcome;
      op.evidence = String(evidence);
      op.settledAt ||= iso();
      touch(job);
      if (['blocked','failed'].includes(job.state) && !unknownEffects(job) &&
        !processAlive(job.attempts.at(-1)?.childPid) &&
        !childDispatchUncertain(job)) releaseResources(state, job);
      return copy(op);
    });
  }
  passGate({jobId, name, evidence}) {
    if (name === 'process_exit_zero') fail('PROCESS_GATE_OWNED_BY_WORKER');
    if (!evidence || !String(evidence).trim()) fail('GATE_EVIDENCE_REQUIRED');
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (job.state !== 'completion_candidate') fail('NOT_READY_TO_VALIDATE');
      const gate = job.gates.find(g => g.name === name);
      if (!gate) fail('GATE_NOT_FOUND');
      gate.passed = true;
      gate.evidence = String(evidence);
      touch(job);
      return copy(gate);
    });
  }
  complete({jobId}) {
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (job.state === 'completed') return {deduplicated: true, job: copy(job)};
      if (job.state !== 'completion_candidate') fail('JOB_NOT_COMPLETION_CANDIDATE');
      if (job.gates.some(g => !g.passed)) fail('COMPLETION_GATES_PENDING');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      job.state = 'completed';
      touch(job).completedAt = iso();
      releaseResources(state, job);
      return {deduplicated: false, job: copy(job)};
    });
  }
  start({jobId}) {
    const attemptId = id('attempt');
    const planned = this.store.update(state => {
      const job = checkJob(state, jobId);
      if (['launching','running'].includes(job.state)) {
        const attempt = job.attempts.at(-1);
        if (processAlive(attempt?.workerPid) || processAlive(attempt?.launcherPid) ||
          (job.state === 'launching' && Date.now() - Date.parse(attempt?.startedAt || 0) < 5000)) {
          return {alreadyRunning: true, job: copy(job)};
        }
        fail('RECOVER_STALE_ATTEMPT_FIRST');
      }
      if (job.state !== 'queued') fail('JOB_NOT_QUEUED');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      for (const resource of job.resources) {
        const owner = state.resources[resource];
        if (owner && owner !== jobId) fail('RESOURCE_BUSY:' + resource);
      }
      for (const resource of job.resources) state.resources[resource] = jobId;
      job.state = 'launching';
      job.attempts.push({id: attemptId, startedAt: iso(), workerPid: null, childPid: null, exitCode: null});
      touch(job);
      return {alreadyRunning: false, job: copy(job)};
    });
    if (planned.alreadyRunning) return planned;
    try {
      const workerFile = new URL('./worker.mjs', import.meta.url);
      const worker = spawn(process.execPath, [fileURLToPath(workerFile), this.root, jobId, attemptId], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      worker.unref();
      this.store.update(state => {
        const job = checkJob(state, jobId);
        const attempt = job.attempts.find(a => a.id === attemptId);
        if (attempt) attempt.launcherPid = worker.pid;
        touch(job);
      });
      return {alreadyRunning: false, jobId, attemptId, workerPid: worker.pid};
    } catch (error) {
      this.store.update(state => {
        const job = checkJob(state, jobId);
        if (job.attempts.at(-1)?.id === attemptId && job.state === 'launching') {
          job.state = 'failed'; job.blockReason = 'WORKER_LAUNCH_FAILED:' + error.message;
          touch(job); releaseResources(state, job);
        }
      });
      throw error;
    }
  }
  retry({jobId}) {
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (!['blocked','failed'].includes(job.state)) fail('JOB_NOT_RETRYABLE');
      const attempt = job.attempts.at(-1);
      if (processAlive(attempt?.workerPid) || processAlive(attempt?.childPid)) fail('PROCESS_STILL_ALIVE');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      job.state = 'queued'; job.blockReason = null;
      job.gates.forEach(g => {g.passed = false; g.evidence = null;});
      releaseResources(state, job);
      touch(job);
      return copy(job);
    });
  }
  recover() {
    const retryIds = [];
    const changed = this.store.update(state => {
      const findings = [];
      for (const job of Object.values(state.jobs)) {
        if (!['launching','running'].includes(job.state)) continue;
        const attempt = job.attempts.at(-1);
        if (processAlive(attempt?.workerPid) || processAlive(attempt?.launcherPid)) continue;
        if (processAlive(attempt?.childPid)) {
          job.state = 'blocked'; job.blockReason = 'CHILD_STILL_ALIVE';
        } else if (childDispatchUncertain(job)) {
          // The child may have started before its PID could be persisted.
          job.state = 'blocked'; job.blockReason = 'CHILD_DISPATCH_UNCERTAIN';
        } else if (job.resume === 'auto_safe' && job.readOnly &&
          !unknownEffects(job) && job.attempts.length <= job.maxRestarts) {
          job.state = 'queued'; job.blockReason = null;
          retryIds.push(job.id);
          releaseResources(state, job);
        } else {
          job.state = 'blocked'; job.blockReason = unknownEffects(job) ?
            'OPERATION_RECONCILIATION_REQUIRED' : 'WORKER_LOST';
          if (!unknownEffects(job)) releaseResources(state, job);
        }
        findings.push({jobId: job.id, state: job.state, reason: job.blockReason});
        touch(job);
      }
      return findings;
    });
    const restarted = [];
    for (const jobId of retryIds) {
      try { restarted.push(this.start({jobId})); }
      catch (error) { restarted.push({jobId, error: error.message}); }
    }
    return {changed, restarted};
  }
}
