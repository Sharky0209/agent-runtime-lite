import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';
import {processAlive} from '../src/state.mjs';

const cliPath = path.resolve('bin/arl.mjs');
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'arl-v02-contract-'));
  return {root,runtime:new Runtime(root),cleanup:()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})};
};
const wait = async (check, timeout=12000) => {
  const start=Date.now();
  while(Date.now()-start<timeout) {
    const got=check();
    if(got) return got;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('WAIT_TIMEOUT');
};
const invoke = (root,...args) => {
  const p=spawnSync(process.execPath,[cliPath,args[0],'--root',root,...args.slice(1)],
    {encoding:'utf8',windowsHide:true,timeout:12000});
  assert.equal(p.status,0,p.stderr||p.error?.message);
  return JSON.parse(p.stdout);
};
const failCli = (root,...args) => {
  const p=spawnSync(process.execPath,[cliPath,args[0],'--root',root,...args.slice(1)],
    {encoding:'utf8',windowsHide:true,timeout:12000});
  assert.equal(p.status,1,p.stdout);
  return JSON.parse(p.stderr).error;
};

test('default API contract requires caller evidence even with no custom gates',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'new-default',title:'default attestation'}).task.id;
    const spec={taskId,key:'work',command:{exe:process.execPath,args:['-e','console.log("ok")']}};
    const job=f.runtime.submit(spec).job;
    assert.equal(job.completionMode,'attested');
    assert.deepEqual(job.gates.map(g=>g.name),['process_exit_zero','caller_attestation']);
    assert.equal(new Runtime(f.root).submit(spec).deduplicated,true);
    assert.throws(()=>f.runtime.submit({...spec,completionMode:'exit_only'}),/JOB_KEY_PAYLOAD_CONFLICT/);
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    assert.throws(()=>f.runtime.passGate({jobId:job.id,name:'caller_attestation'}),/GATE_EVIDENCE_REQUIRED/);
    const attempt=f.runtime.status({jobId:job.id}).job.attempts.at(-1);
    const log=fs.readFileSync(path.join(f.root,'.arl','logs',job.id+'-'+attempt.id+'.log'),'utf8');
    assert.match(log,/ok/);
    new Runtime(f.root).passGate({jobId:job.id,name:'caller_attestation',evidence:'Reviewed actual log in separate Runtime'});
    const done=new Runtime(f.root).complete({jobId:job.id});
    assert.equal(done.job.completionBasis,'caller_attested');
    assert.equal(done.job.state,'completed');
  } finally {f.cleanup();}
});

test('installed-style CLI rejects default completion before independent report readback',async()=>{
  const f=fixture();
  try {
    const report=path.join(f.root,'report.json');
    const task=invoke(f.root,'accept','--key','file','--title','File evidence').task;
    const program='require("node:fs").writeFileSync('+JSON.stringify(report)+',JSON.stringify({items:[2,3],total:5}))';
    const job=invoke(f.root,'submit','--task',task.id,'--key','write',
      '--command',JSON.stringify({exe:process.execPath,args:['-e',program]})).job;
    assert.equal(job.completionMode,'attested');
    invoke(f.root,'start','--job',job.id);
    await wait(()=>invoke(f.root,'status','--job',job.id).job.state==='completion_candidate');
    assert.match(failCli(f.root,'complete','--job',job.id),/COMPLETION_GATES_PENDING/);
    const observed=JSON.parse(fs.readFileSync(report,'utf8'));
    assert.equal(observed.items.reduce((a,b)=>a+b,0),observed.total);
    invoke(f.root,'gate','--job',job.id,'--name','caller_attestation',
      '--evidence','Actual report content independently checked from another CLI process');
    const result=invoke(f.root,'complete','--job',job.id);
    assert.equal(result.job.completionBasis,'caller_attested');
    assert.equal(invoke(f.root,'status','--task',task.id).task.state,'completed');
  } finally {f.cleanup();}
});

test('custom evidence gates suffice without duplicate caller attestation',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'custom',title:'Custom review'}).task.id;
    const job=f.runtime.submit({
      taskId,key:'custom',command:{exe:process.execPath,args:['-e','console.log("CUSTOM_OUTPUT")']},
      gates:['checked_output']
    }).job;
    assert.deepEqual(job.gates.map(g=>g.name),['process_exit_zero','checked_output']);
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    const attempt=f.runtime.status({jobId:job.id}).job.attempts.at(-1);
    assert.match(fs.readFileSync(path.join(f.root,'.arl','logs',job.id+'-'+attempt.id+'.log'),'utf8'),/CUSTOM_OUTPUT/);
    f.runtime.passGate({jobId:job.id,name:'checked_output',evidence:'Actual output readback passed'});
    assert.equal(f.runtime.complete({jobId:job.id}).job.completionBasis,'caller_attested');
  } finally {f.cleanup();}
});

test('missing artifact never automatically attests even after successful process exit',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'missing',title:'Missing output'}).task.id;
    const job=f.runtime.submit({taskId,key:'no-file',command:{exe:process.execPath,args:['-e','process.exit(0)']}}).job;
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.equal(fs.existsSync(path.join(f.root,'required-output.json')),false);
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    assert.equal(f.runtime.status({jobId:job.id}).job.gates.find(g=>g.name==='caller_attestation').passed,false);
  } finally {f.cleanup();}
});

test('exit_only is explicit, labeled unverified, and rejects custom gates',async()=>{
  const f=fixture();
  try {
    const task=invoke(f.root,'accept','--key','exit-only','--title','Exit only').task;
    const job=invoke(f.root,'submit','--task',task.id,'--key','exit-only',
      '--command',JSON.stringify({exe:process.execPath,args:['-e','process.exit(0)']}),
      '--completion-mode','exit_only').job;
    assert.equal(job.completionMode,'exit_only');
    assert.deepEqual(job.gates.map(g=>g.name),['process_exit_zero']);
    invoke(f.root,'start','--job',job.id);
    await wait(()=>invoke(f.root,'status','--job',job.id).job.state==='completion_candidate');
    assert.equal(invoke(f.root,'complete','--job',job.id).job.completionBasis,'process_exit_only');
    assert.match(failCli(f.root,'gate','--job',job.id,'--name','caller_attestation','--evidence','not configured'),
      /NOT_READY_TO_VALIDATE|GATE_NOT_FOUND/);
    assert.match(failCli(f.root,'submit','--task',task.id,'--key','invalid',
      '--command',JSON.stringify({exe:process.execPath,args:[]}),
      '--completion-mode','exit_only','--gate','readback'),/EXIT_ONLY_DISALLOWS_CUSTOM_GATES/);
  } finally {f.cleanup();}
});

test('stored attested policy cannot be bypassed by a missing gate',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'missing-gate',title:'Defensive gate enforcement'}).task.id;
    const job=f.runtime.submit({taskId,key:'work',command:{exe:process.execPath,args:['-e','process.exit(0)']}}).job;
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    f.runtime.store.update(state=>{
      state.jobs[job.id].gates=state.jobs[job.id].gates.filter(g=>g.name!=='caller_attestation');
    });
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/CALLER_ATTESTATION_REQUIRED/);
    assert.equal(f.runtime.status({jobId:job.id}).job.state,'completion_candidate');
  } finally {f.cleanup();}
});

test('old persisted jobs keep v0.1 semantics but are explicitly labeled legacy',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'migration',title:'Legacy state'}).task.id;
    const spec={taskId,key:'old',command:{exe:process.execPath,args:['-e','process.exit(0)']}};
    const job=f.runtime.submit(spec).job;
    f.runtime.store.update(state=>{
      const old=state.jobs[job.id];
      delete old.completionMode;
      old.gates=old.gates.filter(g=>g.name!=='caller_attestation');
    });
    assert.throws(()=>f.runtime.submit(spec),/JOB_KEY_PAYLOAD_CONFLICT/,
      'new default should not silently dedup an old exit-only contract');
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    const completed=f.runtime.complete({jobId:job.id}).job;
    assert.equal(completed.completionBasis,'legacy_process_exit_only');
    assert.equal(completed.completionMode,undefined);
  } finally {f.cleanup();}
});

test('legacy custom gates remain required without injecting new attestation',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'old-custom',title:'Legacy custom evidence'}).task.id;
    const job=f.runtime.submit({taskId,key:'custom',command:{exe:process.execPath,args:['-e','console.log("legacy")']},gates:['legacy_review']}).job;
    f.runtime.store.update(state=>{
      const old=state.jobs[job.id];
      delete old.completionMode;
    });
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    assert.deepEqual(f.runtime.status({jobId:job.id}).job.gates.map(g=>g.name),['process_exit_zero','legacy_review']);
    f.runtime.passGate({jobId:job.id,name:'legacy_review',evidence:'Inspected saved legacy output'});
    assert.equal(f.runtime.complete({jobId:job.id}).job.completionBasis,'legacy_configured_gates');
  } finally {f.cleanup();}
});

test('exit_only still blocks unresolved external operations',async()=>{
  const f=fixture();
  try {
    const taskId=f.runtime.accept({key:'exit-uncertain',title:'Uncertain effect'}).task.id;
    const job=f.runtime.submit({taskId,key:'exit',completionMode:'exit_only',
      command:{exe:process.execPath,args:['-e','console.log("done")']}}).job;
    f.runtime.start({jobId:job.id});
    await wait(()=>['running','completion_candidate'].includes(f.runtime.status({jobId:job.id}).job.state));
    f.runtime.beginOperation({jobId:job.id,key:'external:maybe'});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/OPERATION_RECONCILIATION_REQUIRED/);
    f.runtime.settleOperation({jobId:job.id,key:'external:maybe',outcome:'aborted',evidence:'External destination checked and action never dispatched'});
    assert.equal(f.runtime.complete({jobId:job.id}).job.completionBasis,'process_exit_only');
  } finally {f.cleanup();}
});

test('retry clears caller attestation and never reuses an old attempt evidence',async()=>{
  const f=fixture();
  try {
    const flag=path.join(f.root,'first-attempt.flag');
    const body='const fs=require("node:fs");const f='+JSON.stringify(flag)+';if(!fs.existsSync(f)){fs.writeFileSync(f,"once");process.exit(4)}console.log("retry succeeded")';
    const taskId=f.runtime.accept({key:'retry-gate',title:'Retry evidence'}).task.id;
    const job=f.runtime.submit({taskId,key:'retry',command:{exe:process.execPath,args:['-e',body]}}).job;
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='failed');
    const prev=f.runtime.status({jobId:job.id}).job.attempts.at(-1);
    await wait(()=>!processAlive(prev.workerPid)&&!processAlive(prev.childPid));
    assert.equal(f.runtime.retry({jobId:job.id}).state,'queued');
    f.runtime.start({jobId:job.id});
    await wait(()=>f.runtime.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.runtime.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    assert.equal(f.runtime.status({jobId:job.id}).job.attempts.length,2);
    const last=f.runtime.status({jobId:job.id}).job.attempts.at(-1);
    assert.match(fs.readFileSync(path.join(f.root,'.arl','logs',job.id+'-'+last.id+'.log'),'utf8'),/retry succeeded/);
    f.runtime.passGate({jobId:job.id,name:'caller_attestation',evidence:'Reviewed second attempt log'});
    assert.equal(f.runtime.complete({jobId:job.id}).job.completionBasis,'caller_attested');
  } finally {f.cleanup();}
});
