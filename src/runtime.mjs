import path from 'node:path';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {StateStore, iso, processAlive} from './state.mjs';

const fail = (message) => { throw new Error(message); };
const id = (prefix) => prefix + '-' + randomUUID();
const copy = (value) => JSON.parse(JSON.stringify(value));
const unknownEffects = (job) => job.operations.some(op => op.state === 'uncertain');
// A live PID alone cannot identify a particular worker after PID reuse.
// Heartbeats are advisory: stale identity always blocks instead of auto-retrying.
const workerHeartbeatStale = (attempt) => {
  const last = Date.parse(attempt?.heartbeatAt || attempt?.startedAt || '');
  return !Number.isFinite(last) || Date.now() - last > 30_000;
};
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
const normalizeFileCheck = (root, input) => {
  if (input == null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    typeof input.path !== 'string' || !input.path.trim() ||
    !input.jsonFields || typeof input.jsonFields !== 'object' ||
    Array.isArray(input.jsonFields) || !Object.keys(input.jsonFields).length) fail('FILE_CHECK_INVALID');
  if (path.isAbsolute(input.path) || path.win32.isAbsolute(input.path)) fail('FILE_CHECK_INVALID');
  const absolute = path.resolve(root, input.path);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep)) fail('FILE_CHECK_INVALID');
  return {path: input.path, jsonFields: JSON.parse(JSON.stringify(input.jsonFields))};
};
const inspectFile = (root, spec) => {
  const absolute = path.resolve(root, spec.path);
  let content;
  try { content = fs.readFileSync(absolute, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('FILE_CHECK_MISSING');
    fail('FILE_CHECK_UNREADABLE');
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { fail('FILE_CHECK_INVALID_JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !Object.entries(spec.jsonFields).every(([key, expected]) =>
      Object.hasOwn(parsed,key) && isDeepStrictEqual(parsed[key],expected))) fail('FILE_CHECK_CONTENT_MISMATCH');
  return {checkedFields: Object.keys(spec.jsonFields).length};
};
const checkJob = (state, jobId) => state.jobs[jobId] || fail('JOB_NOT_FOUND');
const checkTask = (state, taskId) => state.tasks[taskId] || fail('TASK_NOT_FOUND');
const touch = (row) => { row.updatedAt = iso(); return row; };
// v0.1.x jobs have no completionMode. Never silently retrofit their gates:
// preserve their stored contract, but label the actual basis on completion.
const completionBasis = (job) => {
  if (job.fileCheck) return job.gates.some(g => g.name !== 'process_exit_zero' && g.name !== 'local_file_check') ?
    'local_file_checked_plus_caller_attested' : 'local_file_checked';
  if (job.completionMode === 'attested') return 'caller_attested';
  if (job.completionMode === 'exit_only') return 'process_exit_only';
  return job.gates.some(g => g.name !== 'process_exit_zero') ?
    'legacy_configured_gates' : 'legacy_process_exit_only';
};
const safeBlockCode = (reason) => {
  const code = String(reason || '').split(':', 1)[0];
  return /^(CHILD_DISPATCH_UNCERTAIN|CHILD_STILL_ALIVE|WORKER_HEARTBEAT_STALE|WORKER_LOST|OPERATION_RECONCILIATION_REQUIRED|PROCESS_TIMEOUT|PROCESS_EXIT|WORKER_LAUNCH_FAILED)$/.test(code) ? code : 'OTHER';
};

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
    resume = 'manual', readOnly = false, maxRestarts = 0, timeoutMs = 0,
    completionMode = 'attested', dependsOn = [], fileCheck = null}) {
    if (!key) fail('JOB_KEY_REQUIRED');
    const normalized = commandShape(command);
    if (!['manual', 'auto_safe'].includes(resume)) fail('RESUME_POLICY_INVALID');
    if (!['attested', 'exit_only'].includes(completionMode)) fail('COMPLETION_MODE_INVALID');
    const normalizedFileCheck = normalizeFileCheck(this.root, fileCheck);
    if (normalizedFileCheck && completionMode === 'exit_only') fail('EXIT_ONLY_DISALLOWS_FILE_CHECK');
    if (resume === 'auto_safe' && !readOnly) fail('AUTO_RECOVERY_REQUIRES_READ_ONLY');
    if (!Array.isArray(resources) || !resources.every(v => typeof v === 'string' && v.trim())) fail('RESOURCES_INVALID');
    if (!Array.isArray(gates) || !gates.every(v => typeof v === 'string' && v.trim() && !['process_exit_zero','caller_attestation','local_file_check'].includes(v))) fail('GATES_INVALID');
    if (new Set(gates).size !== gates.length) fail('DUPLICATE_GATE');
    if (!Array.isArray(dependsOn) || !dependsOn.every(v => typeof v === 'string' && v.trim())) fail('DEPENDENCIES_INVALID');
    if (new Set(dependsOn).size !== dependsOn.length) fail('DUPLICATE_DEPENDENCY');
    if (dependsOn.includes(key)) fail('DEPENDENCY_SELF');
    if (completionMode === 'exit_only' && gates.length) fail('EXIT_ONLY_DISALLOWS_CUSTOM_GATES');
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0) fail('JOB_LIMIT_INVALID');
    const immutable = {command: normalized, required: !!required, readOnly: !!readOnly,
      resume, maxRestarts, timeoutMs, resources: [...new Set(resources)], gates, completionMode, dependsOn: [...dependsOn], fileCheck: normalizedFileCheck};
    return this.store.update(state => {
      checkTask(state, taskId);
      const lookup = JSON.stringify([taskId,key]);
      if (state.jobKeys[lookup]) {
        const previous = checkJob(state, state.jobKeys[lookup]);
        const previousImmutable = {command: previous.command, required: previous.required,
          readOnly: previous.readOnly, resume: previous.resume, maxRestarts: previous.maxRestarts,
          timeoutMs: previous.timeoutMs, resources: previous.resources,
          gates: previous.gates.filter(g => !['process_exit_zero','caller_attestation','local_file_check'].includes(g.name)).map(g => g.name),
          completionMode: previous.completionMode || 'legacy', dependsOn: previous.dependsOn || [],
          fileCheck: previous.fileCheck || null};
        if (JSON.stringify(previousImmutable) !== JSON.stringify(immutable)) fail('JOB_KEY_PAYLOAD_CONFLICT');
        return {deduplicated: true, job: copy(previous)};
      }
      // Predecessors must already exist in this task. This rules out cycles
      // without creating unresolved references or modifying older jobs.
      for (const dependency of dependsOn) {
        if (!state.jobKeys[JSON.stringify([taskId, dependency])]) fail('DEPENDENCY_NOT_FOUND:' + dependency);
      }
      const now = iso();
      const job = {id: id('job'), kind: 'runtime_job', taskId, key, command: normalized,
        required: !!required, readOnly: !!readOnly, resume, maxRestarts, timeoutMs, completionMode,
        dependsOn: [...dependsOn], fileCheck: normalizedFileCheck,
        resources: [...new Set(resources)], operations: [],
        gates: [{name: 'process_exit_zero', passed: false, evidence: null},
          ...(normalizedFileCheck ? [{name: 'local_file_check', passed: false, evidence: null}] : []),
          ...(completionMode === 'attested' && gates.length === 0 && !normalizedFileCheck ?
            [{name: 'caller_attestation', passed: false, evidence: null}] : []),
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
  diagnose() {
    // Only aggregated metadata: no command arguments, paths, user keys,
    // operation evidence, job identifiers or customer content.
    let state;
    try { state = this.store.read(); }
    catch { throw Error('DOCTOR_STATE_UNREADABLE'); }
    const jobs = Object.values(state.jobs);
    const jobsByState = {};
    const blockedReasons = {};
    let attempts = 0;
    let unresolvedOperations = 0;
    let uncertainDispatches = 0;
    let staleWorkerHeartbeats = 0;
    let missingWorkers = 0;
    for (const job of jobs) {
      const jobState = ['queued','launching','running','completion_candidate',
        'blocked','failed','completed','cancelled'].includes(job.state) ? job.state : 'other';
      jobsByState[jobState] = (jobsByState[jobState] || 0) + 1;
      attempts += job.attempts.length;
      unresolvedOperations += job.operations.filter(op => op.state === 'uncertain').length;
      if (childDispatchUncertain(job)) uncertainDispatches++;
      if (jobState === 'blocked' || jobState === 'failed') {
        const reason = safeBlockCode(job.blockReason);
        blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
      }
      if (jobState === 'launching' || jobState === 'running') {
        const attempt = job.attempts.at(-1);
        const workerAlive = processAlive(attempt?.workerPid) || processAlive(attempt?.launcherPid);
        if (workerAlive && workerHeartbeatStale(attempt)) staleWorkerHeartbeats++;
        else if (!workerAlive) missingWorkers++;
      }
    }
    let stateFileBytes = 0;
    try { stateFileBytes = fs.statSync(this.store.file).size; }
    catch (error) { if (error.code !== 'ENOENT') throw Error('DOCTOR_STATE_STAT_FAILED'); }
    return {
      format: 'arl-doctor-v1',
      initialized: stateFileBytes > 0,
      stateFileBytes,
      counts: {
        tasks: Object.keys(state.tasks).length,
        jobs: jobs.length,
        attempts,
        reservedResources: Object.keys(state.resources).length,
        unresolvedOperations,
        uncertainDispatches,
        staleWorkerHeartbeats,
        missingWorkers
      },
      jobsByState,
      blockedReasons,
      guidance: 'Read-only summary. Inspect details locally with arl status; call arl recover only after reviewing possible external effects.'
    };
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
      if (op.state === outcome) return copy(op);
      if (op.state !== 'uncertain') fail('OPERATION_ALREADY_SETTLED');
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
  verifyFile({jobId}) {
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (job.state !== 'completion_candidate') fail('NOT_READY_TO_VALIDATE');
      if (!job.fileCheck) fail('FILE_CHECK_NOT_CONFIGURED');
      const result = inspectFile(this.root, job.fileCheck);
      const gate = job.gates.find(g => g.name === 'local_file_check');
      if (!gate) fail('FILE_GATE_MISSING');
      gate.passed = true;
      gate.source = 'runtime_local_file_readback';
      gate.checkedAt = iso();
      gate.evidence = 'JSON fields independently read and matched';
      touch(job);
      return {passed: true, checkedFields: result.checkedFields, gate: copy(gate)};
    });
  }
  passGate({jobId, name, evidence}) {
    if (name === 'process_exit_zero') fail('PROCESS_GATE_OWNED_BY_WORKER');
    if (name === 'local_file_check') fail('FILE_GATE_OWNED_BY_RUNTIME');
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
      if (job.fileCheck) {
        const gate = job.gates.find(g => g.name === 'local_file_check');
        if (gate?.source !== 'runtime_local_file_readback') fail('FILE_VERIFICATION_REQUIRED');
        // The artifact may change after the earlier verification call.
        // Check it again immediately before committing completion.
        inspectFile(this.root, job.fileCheck);
      }
      // No completed attested job may have only the OS process-exit gate.
      // Custom caller-evidence gates replace, rather than duplicate, the default attestation.
      if (job.completionMode === 'attested' &&
        !job.gates.some(g => g.name !== 'process_exit_zero' && g.passed &&
          typeof g.evidence === 'string' && g.evidence.trim())) fail('CALLER_ATTESTATION_REQUIRED');
      if (job.completionMode != null && !['attested', 'exit_only'].includes(job.completionMode)) fail('COMPLETION_MODE_INVALID');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      job.state = 'completed';
      job.completionBasis = completionBasis(job);
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
        if (((processAlive(attempt?.workerPid) || processAlive(attempt?.launcherPid)) &&
          !workerHeartbeatStale(attempt)) ||
          (job.state === 'launching' && Date.now() - Date.parse(attempt?.startedAt || 0) < 5000)) {
          return {alreadyRunning: true, job: copy(job)};
        }
        fail('RECOVER_STALE_ATTEMPT_FIRST');
      }
      if (job.state !== 'queued') fail('JOB_NOT_QUEUED');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      for (const dependency of job.dependsOn || []) {
        const predecessorId = state.jobKeys[JSON.stringify([job.taskId, dependency])];
        if (!predecessorId || state.jobs[predecessorId]?.state !== 'completed') {
          fail('JOB_DEPENDENCIES_PENDING:' + dependency);
        }
      }
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
  plan({taskId}) {
    if (!taskId) fail('TASK_ID_REQUIRED');
    const state = this.store.read();
    checkTask(state, taskId);
    return {taskId, jobs: Object.values(state.jobs).filter(job => job.taskId === taskId).map(job => {
      const waitingFor = (job.dependsOn || []).filter(key => {
        const predecessor = state.jobKeys[JSON.stringify([taskId, key])];
        return !predecessor || state.jobs[predecessor]?.state !== 'completed';
      });
      const resourcesBusy = job.resources.filter(key => state.resources[key] && state.resources[key] !== job.id);
      return {jobId: job.id, key: job.key, state: job.state, dependsOn: job.dependsOn || [],
        waitingFor, resourcesBusy, ready: job.state === 'queued' && !waitingFor.length && !resourcesBusy.length};
    })};
  }
  runReady({taskId}) {
    // Explicit, one-shot scheduling: callers invoke this again after evidence
    // completion. It does not poll, validate outcomes or replay failed jobs.
    if (!taskId) fail('TASK_ID_REQUIRED');
    const snapshot = this.store.read();
    checkTask(snapshot, taskId);
    const queued = Object.values(snapshot.jobs)
      .filter(job => job.state === 'queued' && job.taskId === taskId);
    const started = [];
    const waiting = [];
    for (const job of queued) {
      try {
        const result = this.start({jobId: job.id});
        if (!result.alreadyRunning) started.push({jobId: job.id, attemptId: result.attemptId});
      } catch (error) {
        if (/^(JOB_DEPENDENCIES_PENDING|RESOURCE_BUSY|JOB_NOT_QUEUED):?/.test(error.message)) {
          waiting.push({jobId: job.id, reason: error.message});
        } else throw error;
      }
    }
    return {started, waiting};
  }
  retry({jobId}) {
    return this.store.update(state => {
      const job = checkJob(state, jobId);
      if (!['blocked','failed'].includes(job.state)) fail('JOB_NOT_RETRYABLE');
      const attempt = job.attempts.at(-1);
      if (processAlive(attempt?.workerPid) || processAlive(attempt?.childPid)) fail('PROCESS_STILL_ALIVE');
      if (unknownEffects(job)) fail('OPERATION_RECONCILIATION_REQUIRED');
      job.state = 'queued'; job.blockReason = null;
      job.gates.forEach(g => {
        g.passed = false; g.evidence = null;
        delete g.source; delete g.checkedAt;
      });
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
        const workerPidAlive = processAlive(attempt?.workerPid) || processAlive(attempt?.launcherPid);
        if (workerPidAlive && !workerHeartbeatStale(attempt)) continue;
        if (workerPidAlive) {
          job.state = 'blocked'; job.blockReason = 'WORKER_HEARTBEAT_STALE';
        } else if (processAlive(attempt?.childPid)) {
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
