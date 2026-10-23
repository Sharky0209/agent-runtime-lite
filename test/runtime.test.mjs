import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';

const make = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-test-'));
  return {root, rt: new Runtime(root), cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
};
const command = (body = 'console.log("success")') => ({exe: process.execPath, args: ['-e', body]});
const wait = async (check, timeout = 12000) => {
  const start = Date.now();
  for (;;) {
    const out = check();
    if (out) return out;
    if (Date.now() - start > timeout) throw Error('WAIT_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

test('task acceptance is idempotent across separate Runtime instances', () => {
  const f = make();
  try {
    const one = f.rt.accept({key: 'example', title: 'A'});
    const again = new Runtime(f.root).accept({key:'example',title:'Different'});
    assert.equal(one.deduplicated, false);
    assert.equal(again.deduplicated, true);
    assert.equal(again.task.id, one.task.id);
    assert.equal(again.task.title, 'A');
    assert.equal(f.rt.status({taskId: one.task.id}).task.state, 'active');
  } finally {f.cleanup();}
});

test('job submission deduplicates and conflicts on changed command', () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'one',title:'One'}).task.id;
    const args = {taskId,key:'work',command:command()};
    const first = f.rt.submit(args);
    const again = new Runtime(f.root).submit(args);
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.id, first.job.id);
    assert.throws(() => f.rt.submit({...args,command:command('console.log("different")')}), /JOB_KEY_PAYLOAD_CONFLICT/);
    assert.throws(() => f.rt.submit({...args,gates:['unreviewed']}), /JOB_KEY_PAYLOAD_CONFLICT/);
    assert.throws(() => f.rt.submit({...args,resources:['different-target']}), /JOB_KEY_PAYLOAD_CONFLICT/);
    assert.equal(f.rt.status({taskId}).task.state, 'running');
  } finally {f.cleanup();}
});

test('auto recovery never accepts a command with unproven side effects', () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'policy',title:'Policy'}).task.id;
    assert.throws(() => f.rt.submit({taskId,key:'write',command:command(),resume:'auto_safe'}), /READ_ONLY/);
    assert.throws(() => f.rt.submit({taskId,key:'gates',command:command(),gates:['process_exit_zero']}), /GATES_INVALID/);
  } finally {f.cleanup();}
});

test('operations are uncertain until reconciled and cannot be replayed as new', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'ops',title:'Operations'}).task.id;
    const jobId = f.rt.submit({taskId,key:'ops',command:command(),resources:['resource:one']}).job.id;
    assert.throws(() => f.rt.beginOperation({jobId,key:'send-one'}), /JOB_NOT_ACTIVE/);
    f.rt.start({jobId});
    await wait(() => f.rt.status({jobId}).job.state === 'completion_candidate');
    const first = f.rt.beginOperation({jobId,key:'send-one'});
    const second = new Runtime(f.root).beginOperation({jobId,key:'send-one'});
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.operation.state, 'uncertain');
    assert.throws(() => f.rt.settleOperation({jobId,key:'send-one',outcome:'confirmed'}), /EVIDENCE_REQUIRED/);
    const settled = f.rt.settleOperation({jobId,key:'send-one',outcome:'confirmed',evidence:'external readback confirms it'});
    assert.equal(settled.state, 'confirmed');
    assert.throws(() => f.rt.settleOperation({jobId,key:'send-one',outcome:'aborted',evidence:'later guess'}), /ALREADY_SETTLED/);
    assert.equal(f.rt.beginOperation({jobId,key:'send-one'}).operation.state, 'confirmed');
  } finally {f.cleanup();}
});

test('detached worker produces a real completion candidate; gates require evidence', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'run',title:'Run'}).task.id;
    const jobId = f.rt.submit({taskId,key:'run',command:command('console.log("child-ran")'),
      gates:['readback'],resources:['shared:one']}).job.id;
    assert.equal(f.rt.start({jobId}).alreadyRunning, false);
    await wait(() => f.rt.status({jobId}).job.state === 'completion_candidate');
    const job = f.rt.status({jobId}).job;
    assert.equal(job.attempts.length,1);
    assert.equal(job.attempts[0].exitCode, 0);
    assert.equal(f.rt.status({taskId}).task.state, 'validating');
    assert.throws(() => f.rt.complete({jobId}), /COMPLETION_GATES_PENDING/);
    assert.throws(() => f.rt.passGate({jobId,name:'process_exit_zero',evidence:'manual'}), /PROCESS_GATE_OWNED_BY_WORKER/);
    assert.equal(job.gates.find(g => g.name==='process_exit_zero').passed, true);
    const logs = fs.readdirSync(path.join(f.root,'.arl','logs'));
    assert.equal(logs.length,1);
    assert.match(fs.readFileSync(path.join(f.root,'.arl','logs',logs[0]),'utf8'), /child-ran/);
    f.rt.passGate({jobId,name:'readback',evidence:'external output file contents checked'});
    assert.equal(f.rt.complete({jobId}).job.state, 'completed');
    assert.equal(f.rt.status({taskId}).task.state, 'completed');
    assert.equal(f.rt.complete({jobId}).deduplicated, true);
  } finally {f.cleanup();}
});

test('resource conflict blocks concurrent jobs and releases on completion', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'lease',title:'Lease'}).task.id;
    const j1 = f.rt.submit({taskId,key:'a',command:command('setTimeout(()=>{},450)'),resources:['shared:doc']}).job.id;
    const j2 = f.rt.submit({taskId,key:'b',command:command(),resources:['shared:doc']}).job.id;
    f.rt.start({jobId:j1});
    assert.throws(() => f.rt.start({jobId:j2}), /RESOURCE_BUSY/);
    await wait(() => f.rt.status({jobId:j1}).job.state === 'completion_candidate');
    assert.throws(() => f.rt.start({jobId:j2}), /RESOURCE_BUSY/);
    f.rt.complete({jobId:j1});
    f.rt.start({jobId:j2});
    await wait(() => f.rt.status({jobId:j2}).job.state === 'completion_candidate');
    f.rt.complete({jobId:j2});
    assert.equal(f.rt.status({taskId}).task.state,'completed');
  } finally {f.cleanup();}
});

test('unverified effects block completion even after a successful OS exit', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'effects',title:'Effects'}).task.id;
    const jobId = f.rt.submit({taskId,key:'send',command:command()}).job.id;
    f.rt.start({jobId});
    await wait(() => ['running','completion_candidate'].includes(f.rt.status({jobId}).job.state));
    f.rt.beginOperation({jobId,key:'remote-write'});
    await wait(() => f.rt.status({jobId}).job.state==='completion_candidate');
    assert.throws(()=>f.rt.complete({jobId}), /OPERATION_RECONCILIATION_REQUIRED/);
    f.rt.settleOperation({jobId,key:'remote-write',outcome:'aborted',evidence:'target inspected; write not applied'});
    assert.equal(f.rt.complete({jobId}).job.state,'completed');
  } finally {f.cleanup();}
});

test('nonzero child exit records failure and allows an explicit retry', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'bad',title:'Bad'}).task.id;
    const jobId = f.rt.submit({taskId,key:'fail',command:command('process.exit(7)')}).job.id;
    f.rt.start({jobId});
    await wait(() => f.rt.status({jobId}).job.state === 'failed');
    assert.equal(f.rt.status({taskId}).task.state, 'blocked');
    assert.equal(f.rt.status({jobId}).job.attempts[0].exitCode,7);
    assert.throws(() => f.rt.complete({jobId}), /JOB_NOT_COMPLETION_CANDIDATE/);
    assert.equal(f.rt.retry({jobId}).state,'queued');
  } finally {f.cleanup();}
});

test('recovery blocks uncertain lost workers; safe read-only jobs can resume', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'recover',title:'Recover'}).task.id;
    const manual = f.rt.submit({taskId,key:'manual',command:command()}).job.id;
    const safe = f.rt.submit({taskId,key:'safe',command:command('console.log("recovered")'),readOnly:true,resume:'auto_safe',maxRestarts:1}).job.id;
    f.rt.store.update(state => {
      for (const jid of [manual,safe]) {
        const job=state.jobs[jid];
        job.state='running';
        job.attempts=[{id:'lost',workerPid:99999999,launcherPid:99999999,childPid:99999999}];
      }
    });
    const result = f.rt.recover();
    assert.equal(result.changed.length,2);
    assert.equal(f.rt.status({jobId:manual}).job.state,'blocked');
    assert.equal(result.restarted.length,1);
    await wait(() => f.rt.status({jobId:safe}).job.state==='completion_candidate');
    assert.equal(f.rt.status({jobId:safe}).job.attempts.length,2);
    f.rt.complete({jobId:safe});
  } finally {f.cleanup();}
});

test('concurrent CLI invocations share one task and one worker attempt', async () => {
  const f = make();
  const cli = path.resolve('bin/arl.mjs');
  const launchCli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli,...args], {windowsHide:true});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
  });
  try {
    const [a,b] = await Promise.all([
      launchCli(['accept','--root',f.root,'--key','same','--title','Same']),
      launchCli(['accept','--root',f.root,'--key','same','--title','Same'])
    ]);
    assert.equal(a.task.id,b.task.id);
    assert.equal(f.rt.status().tasks.length,1);
    const jobId=f.rt.submit({taskId:a.task.id,key:'once',command:command('setTimeout(()=>console.log("once"),700)')}).job.id;
    const [one,two] = await Promise.all([
      launchCli(['start','--root',f.root,'--job',jobId]),
      launchCli(['start','--root',f.root,'--job',jobId])
    ]);
    assert.equal([one.alreadyRunning,two.alreadyRunning].filter(Boolean).length,1);
    await wait(() => f.rt.status({jobId}).job.state==='completion_candidate');
    assert.equal(f.rt.status({jobId}).job.attempts.length,1);
    f.rt.complete({jobId});
  } finally {f.cleanup();}
});

test('a failed execution releases its resource reservation', async () => {
  const f = make();
  try {
    const taskId=f.rt.accept({key:'failure-resource',title:'Failure'}).task.id;
    const bad=f.rt.submit({taskId,key:'bad',command:command('process.exit(4)'),resources:['shared:resource']}).job.id;
    const good=f.rt.submit({taskId,key:'good',command:command(),resources:['shared:resource']}).job.id;
    f.rt.start({jobId:bad});
    await wait(()=>f.rt.status({jobId:bad}).job.state==='failed');
    assert.equal(f.rt.start({jobId:good}).alreadyRunning,false);
    await wait(()=>f.rt.status({jobId:good}).job.state==='completion_candidate');
    f.rt.complete({jobId:good});
  } finally {f.cleanup();}
});

test('a failed job with an uncertain operation retains resources until reconciliation', async () => {
  const f = make();
  try {
    const taskId=f.rt.accept({key:'uncertain-resource',title:'Uncertain'}).task.id;
    const bad=f.rt.submit({taskId,key:'bad',command:command('setTimeout(()=>process.exit(9),250)'),resources:['shared:resource']}).job.id;
    const good=f.rt.submit({taskId,key:'good',command:command(),resources:['shared:resource']}).job.id;
    f.rt.start({jobId:bad});
    await wait(()=>f.rt.status({jobId:bad}).job.state==='running');
    f.rt.beginOperation({jobId:bad,key:'external-write'});
    await wait(()=>f.rt.status({jobId:bad}).job.state==='failed');
    assert.throws(()=>f.rt.start({jobId:good}),/RESOURCE_BUSY/);
    f.rt.settleOperation({jobId:bad,key:'external-write',outcome:'confirmed',evidence:'external destination readback'});
    assert.equal(f.rt.start({jobId:good}).alreadyRunning,false);
    await wait(()=>f.rt.status({jobId:good}).job.state==='completion_candidate');
    f.rt.complete({jobId:good});
  } finally {f.cleanup();}
});

test('reconciled operations cannot release resources while a recovered child is alive', () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'child-live',title:'Child still alive'}).task.id;
    const holder = f.rt.submit({taskId,key:'holder',command:command(),resources:['shared:held']}).job.id;
    const follower = f.rt.submit({taskId,key:'follower',command:command(),resources:['shared:held']}).job.id;
    f.rt.store.update(state => {
      const job = state.jobs[holder];
      job.state = 'running';
      job.attempts = [{id:'lost-worker',workerPid:99999999,launcherPid:99999999,childPid:process.pid}];
      job.operations = [{key:'external',state:'uncertain',at:new Date().toISOString(),evidence:null}];
      state.resources['shared:held'] = holder;
    });
    assert.equal(f.rt.recover().changed[0].reason, 'CHILD_STILL_ALIVE');
    f.rt.settleOperation({jobId:holder,key:'external',outcome:'confirmed',evidence:'external destination checked'});
    assert.throws(() => f.rt.start({jobId:follower}), /RESOURCE_BUSY/);
    assert.equal(f.rt.status({jobId:holder}).job.state, 'blocked');
  } finally {f.cleanup();}
});

test('a missing executable becomes a recorded job failure, never a false success', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'missing-executable',title:'Missing executable'}).task.id;
    const jobId = f.rt.submit({
      taskId, key:'not-found',
      command:{exe:'arl-command-that-does-not-exist-7832',args:[]},
      resources:['missing:resource']
    }).job.id;
    f.rt.start({jobId});
    await wait(() => f.rt.status({jobId}).job.state === 'failed');
    const job = f.rt.status({jobId}).job;
    assert.match(job.blockReason, /ENOENT|not found/i);
    assert.equal(job.gates[0].passed, false);
    assert.equal(f.rt.status({taskId}).task.state, 'blocked');
    assert.throws(() => f.rt.complete({jobId}), /JOB_NOT_COMPLETION_CANDIDATE/);
  } finally {f.cleanup();}
});

test('timeout terminates the child and cannot satisfy completion gates', async () => {
  const f = make();
  try {
    const taskId=f.rt.accept({key:'timeout-job',title:'Timed execution'}).task.id;
    const jobId=f.rt.submit({
      taskId, key:'slow',
      command:command('setTimeout(() => console.log("should-not-finish"), 10000)'),
      timeoutMs:500
    }).job.id;
    f.rt.start({jobId});
    await wait(() => f.rt.status({jobId}).job.state === 'failed');
    const job=f.rt.status({jobId}).job;
    assert.equal(job.gates[0].passed, false);
    assert.match(job.blockReason, /PROCESS_TIMEOUT/);
    assert.notEqual(job.attempts.at(-1).exitCode, 0);
    assert.throws(() => f.rt.complete({jobId}), /JOB_NOT_COMPLETION_CANDIDATE/);
  } finally {f.cleanup();}
});

test('a child exiting zero after SIGTERM still fails its deadline', {skip: process.platform === 'win32'}, async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'deadline-catch',title:'Trap SIGTERM'}).task.id;
    const jobId = f.rt.submit({
      taskId, key:'trap',
      command:command("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"),
      timeoutMs:1200
    }).job.id;
    f.rt.start({jobId});
    await wait(() => ['failed','completion_candidate'].includes(f.rt.status({jobId}).job.state));
    const job = f.rt.status({jobId}).job;
    assert.equal(job.attempts.at(-1).exitCode, 0, 'child trapped SIGTERM and exited zero');
    assert.equal(job.state, 'failed');
    assert.match(job.blockReason, /PROCESS_TIMEOUT/);
    assert.equal(job.gates[0].passed, false);
  } finally {f.cleanup();}
});

test('a child ignoring SIGTERM is force-stopped after its deadline', {skip: process.platform === 'win32'}, async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'deadline-ignore',title:'Ignore SIGTERM'}).task.id;
    const jobId = f.rt.submit({
      taskId, key:'ignore',
      command:command("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
      timeoutMs:1200
    }).job.id;
    f.rt.start({jobId});
    await wait(() => f.rt.status({jobId}).job.state === 'failed', 10000);
    const job = f.rt.status({jobId}).job;
    assert.equal(job.blockReason, 'PROCESS_TIMEOUT:1200');
    assert.equal(job.gates[0].passed, false);
  } finally {f.cleanup();}
});

test('process survives a CLI invocation and status can be read in a new process', async () => {
  const f = make();
  try {
    const taskId = f.rt.accept({key:'cli',title:'CLI'}).task.id;
    const jobId = f.rt.submit({taskId,key:'cmd',command:command('console.log("separate-process")')}).job.id;
    const cli = path.resolve('bin/arl.mjs');
    const called = spawnSync(process.execPath,[cli,'start','--root',f.root,'--job',jobId],{encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(called.status,0,called.stderr);
    assert.equal(JSON.parse(called.stdout).jobId,jobId);
    await wait(()=>f.rt.status({jobId}).job.state==='completion_candidate');
    const status = spawnSync(process.execPath,[cli,'status','--root',f.root,'--job',jobId],{encoding:'utf8',timeout:5000,windowsHide:true});
    assert.equal(status.status,0,status.stderr);
    assert.equal(JSON.parse(status.stdout).job.attempts[0].exitCode,0);
    f.rt.complete({jobId});
  } finally {f.cleanup();}
});
