import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';

const cli = path.resolve('bin/arl.mjs');
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-workflow-'));
  return {root, rt: new Runtime(root), cleanup: () => fs.rmSync(root, {recursive:true,force:true,maxRetries:12,retryDelay:150})};
};
const invoke = (root, ...args) => {
  const result = spawnSync(process.execPath,[cli,args[0],'--root',root,...args.slice(1)],
    {encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};
const invokeAsync = (root, ...args) => new Promise((resolve, reject) => {
  const child=spawn(process.execPath,[cli,args[0],'--root',root,...args.slice(1)], {windowsHide:true});
  let stdout='';let stderr='';
  child.stdout.on('data', data=>{stdout+=data;});
  child.stderr.on('data', data=>{stderr+=data;});
  child.on('error',reject);
  child.on('close',code=>code===0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
});
const wait = async (read, timeoutMs=12000) => {
  const started=Date.now();
  while (Date.now()-started<timeoutMs) {
    const value=read();
    if (value) return value;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('WORKFLOW_WAIT_TIMEOUT');
};
const command = (script='process.exit(0)') => ({exe:process.execPath,args:['-e',script]});

test('dependencies are same-task, previously registered keys and immutable across retries', () => {
  const f=fixture();
  try {
    const taskId=f.rt.accept({key:'pipeline',title:'Pipeline'}).task.id;
    const other=f.rt.accept({key:'other',title:'Other'}).task.id;
    const build=f.rt.submit({taskId,key:'build',command:command()}).job;
    f.rt.submit({taskId:other,key:'external',command:command()});
    const spec={taskId,key:'inspect',command:command(),dependsOn:['build']};
    const next=f.rt.submit(spec).job;
    assert.deepEqual(next.dependsOn,['build']);
    const original=fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8');
    const plan=f.rt.plan({taskId});
    assert.deepEqual(plan.jobs.find(job=>job.jobId===next.id).waitingFor,['build']);
    assert.equal(plan.jobs.find(job=>job.jobId===next.id).ready,false);
    assert.equal(plan.jobs.find(job=>job.jobId===build.id).ready,true);
    assert.equal(fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8'),original,
      'the readiness inspection must not modify workspace state');
    assert.throws(()=>f.rt.plan({}),/TASK_ID_REQUIRED/);
    assert.throws(()=>f.rt.runReady({}),/TASK_ID_REQUIRED/);
    assert.equal(new Runtime(f.root).submit(spec).deduplicated,true);
    assert.throws(()=>f.rt.submit({...spec,dependsOn:[]}),/JOB_KEY_PAYLOAD_CONFLICT/);
    assert.throws(()=>f.rt.submit({taskId,key:'missing',command:command(),dependsOn:['not-registered']}),/DEPENDENCY_NOT_FOUND/);
    assert.throws(()=>f.rt.submit({taskId,key:'cross',command:command(),dependsOn:['external']}),/DEPENDENCY_NOT_FOUND/);
    assert.throws(()=>f.rt.submit({taskId,key:'self',command:command(),dependsOn:['self']}),/DEPENDENCY_SELF/);
    assert.throws(()=>f.rt.submit({taskId,key:'dup',command:command(),dependsOn:['build','build']}),/DUPLICATE_DEPENDENCY/);
    assert.throws(()=>f.rt.submit({taskId,key:'wrong',command:command(),dependsOn:'build'}),/DEPENDENCIES_INVALID/);
    assert.throws(()=>f.rt.start({jobId:next.id}),/JOB_DEPENDENCIES_PENDING/);
    assert.equal(f.rt.status({jobId:next.id}).job.attempts.length,0);
    assert.equal(f.rt.status({jobId:build.id}).job.state,'queued');
  } finally {f.cleanup();}
});

test('real CLI workflow waits for caller-attested predecessor before starting the dependent child', async () => {
  const f=fixture();
  try {
    const report=path.join(f.root,'stage-one.json');
    const final=path.join(f.root,'stage-two.txt');
    const task=invoke(f.root,'accept','--key','flow','--title','Two-step example').task;
    const producer=invoke(f.root,'submit','--task',task.id,'--key','produce',
      '--command',JSON.stringify(command('require("node:fs").writeFileSync('+JSON.stringify(report)+',JSON.stringify({answer:42}))'))).job;
    const consumer=invoke(f.root,'submit','--task',task.id,'--key','consume',
      '--depends-on','["produce"]',
      '--command',JSON.stringify(command('const fs=require("node:fs");const value=JSON.parse(fs.readFileSync('+JSON.stringify(report)+',"utf8"));fs.writeFileSync('+JSON.stringify(final)+',String(value.answer))'))).job;
    assert.deepEqual(consumer.dependsOn,['produce']);
    const plan=invoke(f.root,'plan','--task',task.id);
    assert.deepEqual(plan.jobs.find(job=>job.jobId===consumer.id).waitingFor,['produce']);
    assert.match(JSON.stringify(invoke(f.root,'run-ready','--task',task.id).started),new RegExp(producer.id));
    await wait(()=>invoke(f.root,'status','--job',producer.id).job.state==='completion_candidate');
    assert.equal(fs.existsSync(report),true);
    assert.deepEqual(invoke(f.root,'run-ready','--task',task.id).started,[],
      'successful OS exit alone must not unblock dependents');
    assert.equal(invoke(f.root,'status','--job',consumer.id).job.attempts.length,0);
    assert.equal(fs.existsSync(final),false);
    assert.equal(JSON.parse(fs.readFileSync(report,'utf8')).answer,42);
    invoke(f.root,'gate','--job',producer.id,'--name','caller_attestation',
      '--evidence','Independently read back stage-one.json and checked answer 42');
    invoke(f.root,'complete','--job',producer.id);
    const readyPlan=invoke(f.root,'plan','--task',task.id);
    assert.equal(readyPlan.jobs.find(job=>job.jobId===consumer.id).ready,true);
    const next=invoke(f.root,'run-ready','--task',task.id);
    assert.equal(next.started.length,1);
    assert.equal(next.started[0].jobId,consumer.id);
    await wait(()=>invoke(f.root,'status','--job',consumer.id).job.state==='completion_candidate');
    assert.equal(fs.readFileSync(final,'utf8'),'42');
    assert.equal(invoke(f.root,'run-ready','--task',task.id).started.length,0);
    invoke(f.root,'gate','--job',consumer.id,'--name','caller_attestation','--evidence','Final text file read back as 42');
    invoke(f.root,'complete','--job',consumer.id);
    assert.equal(invoke(f.root,'status','--task',task.id).task.state,'completed');
    assert.equal(invoke(f.root,'status','--job',consumer.id).job.attempts.length,1);
  } finally {f.cleanup();}
});

test('runReady holds failed dependencies and respects resource reservations for sibling jobs', async () => {
  const f=fixture();
  try {
    const taskId=f.rt.accept({key:'siblings',title:'Sibling jobs'}).task.id;
    const first=f.rt.submit({taskId,key:'first',command:command('setTimeout(()=>{},400)'),resources:['shared-output']}).job;
    const second=f.rt.submit({taskId,key:'second',command:command(),resources:['shared-output']}).job;
    const child=f.rt.submit({taskId,key:'child',command:command(),dependsOn:['first']}).job;
    const start=f.rt.runReady({taskId});
    assert.equal(start.started.length,1);
    assert.equal(start.started[0].jobId,first.id);
    assert.ok(start.waiting.some(item=>item.jobId===second.id && item.reason.startsWith('RESOURCE_BUSY')));
    assert.ok(start.waiting.some(item=>item.jobId===child.id && item.reason.startsWith('JOB_DEPENDENCIES_PENDING')));
    await wait(()=>f.rt.status({jobId:first.id}).job.state==='completion_candidate');
    f.rt.passGate({jobId:first.id,name:'caller_attestation',evidence:'First child completed and output checked'});
    f.rt.complete({jobId:first.id});
    const ready=f.rt.runReady({taskId});
    assert.deepEqual(new Set(ready.started.map(item=>item.jobId)),new Set([second.id,child.id]));
    await wait(()=>f.rt.status({jobId:child.id}).job.state==='completion_candidate' &&
      f.rt.status({jobId:second.id}).job.state==='completion_candidate');
  } finally {f.cleanup();}
});

test('two simultaneous CLI schedulers still launch exactly one worker attempt', async () => {
  const f=fixture();
  try {
    const marker=path.join(f.root,'only-once.txt');
    const taskId=f.rt.accept({key:'race',title:'Scheduler race'}).task.id;
    const job=f.rt.submit({taskId,key:'single',command:command(
      'require("node:fs").appendFileSync('+JSON.stringify(marker)+',"X")')}).job;
    const results=await Promise.all([
      invokeAsync(f.root,'run-ready','--task',taskId),
      invokeAsync(f.root,'run-ready','--task',taskId)
    ]);
    assert.equal(results.flatMap(r=>r.started).length,1);
    await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
    assert.equal(fs.readFileSync(marker,'utf8'),'X');
    assert.equal(f.rt.status({jobId:job.id}).job.attempts.length,1);
  } finally {f.cleanup();}
});

test('failed predecessor never starts dependent automatically or through direct start', async () => {
  const f=fixture();
  try {
    const taskId=f.rt.accept({key:'failed',title:'Failure gate'}).task.id;
    const failed=f.rt.submit({taskId,key:'failed',command:command('process.exit(3)')}).job;
    const blocked=f.rt.submit({taskId,key:'blocked',command:command(),dependsOn:['failed']}).job;
    f.rt.runReady({taskId});
    await wait(()=>f.rt.status({jobId:failed.id}).job.state==='failed');
    const result=f.rt.runReady({taskId});
    assert.deepEqual(result.started,[]);
    assert.equal(f.rt.status({jobId:blocked.id}).job.attempts.length,0);
    assert.throws(()=>f.rt.start({jobId:blocked.id}),/JOB_DEPENDENCIES_PENDING/);
  } finally {f.cleanup();}
});
