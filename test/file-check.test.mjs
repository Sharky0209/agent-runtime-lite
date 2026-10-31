import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';

const cli=path.resolve('bin/arl.mjs');
const make=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arl-file-check-'));
  return {root,rt:new Runtime(root),cleanup:()=>fs.rmSync(root,{force:true,recursive:true,maxRetries:10,retryDelay:150})};
};
const command=script=>({exe:process.execPath,args:['-e',script]});
const wait=async(fn,timeout=12000)=>{
  const started=Date.now();
  while(Date.now()-started<timeout) {
    if(fn()) return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('FILE_CHECK_WAIT_TIMEOUT');
};
const cliCall=(root,...args)=>{
  const r=spawnSync(process.execPath,[cli,args[0],'--root',root,...args.slice(1)],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  return JSON.parse(r.stdout);
};
const fileSpec={path:'report.json',jsonFields:{total:5,meta:{ok:true}}};

test('CLI verifies actual JSON fields and unblocks the dependent job without fake caller evidence',async()=>{
  const f=make();
  try {
    const producer=command('require("node:fs").writeFileSync("report.json",JSON.stringify({total:5,meta:{ok:true},extra:10}))');
    const task=cliCall(f.root,'accept','--key','verified-output','--title','Verify report').task;
    const job=cliCall(f.root,'submit','--task',task.id,'--key','produce',
      '--command',JSON.stringify(producer),'--file-check',JSON.stringify(fileSpec)).job;
    assert.equal(job.completionMode,'attested');
    assert.deepEqual(job.gates.map(g=>g.name),['process_exit_zero','local_file_check']);
    const downstream=cliCall(f.root,'submit','--task',task.id,'--key','downstream',
      '--depends-on','["produce"]','--command',JSON.stringify(command('console.log("SECOND_OK")'))).job;
    cliCall(f.root,'run-ready','--task',task.id);
    await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
    assert.throws(()=>f.rt.passGate({jobId:job.id,name:'local_file_check',evidence:'I checked it'}),/FILE_GATE_OWNED_BY_RUNTIME/);
    assert.throws(()=>f.rt.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    assert.equal(f.rt.plan({taskId:task.id}).jobs.find(j=>j.jobId===downstream.id).ready,false);
    const first=cliCall(f.root,'verify-file','--job',job.id);
    assert.equal(first.passed,true);
    assert.equal(first.gate.name,'local_file_check');
    assert.equal(first.gate.source,'runtime_local_file_readback');
    assert.equal(first.checkedFields,2);
    assert.equal(new Runtime(f.root).verifyFile({jobId:job.id}).passed,true);
    const done=cliCall(f.root,'complete','--job',job.id).job;
    assert.equal(done.completionBasis,'local_file_checked');
    assert.equal(f.rt.plan({taskId:task.id}).jobs.find(j=>j.jobId===downstream.id).ready,true);
    const start=cliCall(f.root,'run-ready','--task',task.id);
    assert.deepEqual(start.started.map(j=>j.jobId),[downstream.id]);
    await wait(()=>f.rt.status({jobId:downstream.id}).job.state==='completion_candidate');
    const attempt=f.rt.status({jobId:downstream.id}).job.attempts.at(-1);
    assert.match(fs.readFileSync(path.join(f.root,'.arl','logs',downstream.id+'-'+attempt.id+'.log'),'utf8'),/SECOND_OK/);
  } finally {f.cleanup();}
});

test('missing, malformed and mismatched local artifacts fail independently of zero process exit',async()=>{
  const f=make();
  try {
    const task=f.rt.accept({key:'bad',title:'Bad outputs'}).task.id;
    for(const [key,body,error] of [
      ['missing','process.exit(0)','FILE_CHECK_MISSING'],
      ['malformed','require("node:fs").writeFileSync("report.json","not-json")','FILE_CHECK_INVALID_JSON'],
      ['mismatch','require("node:fs").writeFileSync("report.json",JSON.stringify({total:4,meta:{ok:true}}))','FILE_CHECK_CONTENT_MISMATCH']
    ]) {
      const job=f.rt.submit({taskId:task,key,command:command(body),fileCheck:fileSpec}).job;
      f.rt.start({jobId:job.id});
      await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
      assert.throws(()=>f.rt.verifyFile({jobId:job.id}),new RegExp(error));
      assert.throws(()=>f.rt.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
      if(key==='malformed') fs.rmSync(path.join(f.root,'report.json'));
      if(key==='mismatch') fs.rmSync(path.join(f.root,'report.json'));
    }
  } finally {f.cleanup();}
});

test('verification rechecks the file during completion so stale evidence cannot pass',async()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'stale',title:'Stale result'}).task.id;
    const job=f.rt.submit({taskId,key:'write',command:command('require("node:fs").writeFileSync("report.json",JSON.stringify({total:5,meta:{ok:true}}))'),fileCheck:fileSpec}).job;
    f.rt.start({jobId:job.id});
    await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
    f.rt.verifyFile({jobId:job.id});
    fs.writeFileSync(path.join(f.root,'report.json'),JSON.stringify({total:0,meta:{ok:false}}));
    assert.throws(()=>f.rt.complete({jobId:job.id}),/FILE_CHECK_CONTENT_MISMATCH/);
    assert.equal(f.rt.status({jobId:job.id}).job.state,'completion_candidate');
    fs.writeFileSync(path.join(f.root,'report.json'),JSON.stringify({total:5,meta:{ok:true}}));
    assert.equal(new Runtime(f.root).complete({jobId:job.id}).job.completionBasis,'local_file_checked');
  } finally {f.cleanup();}
});

test('file contract is immutable and both local readback and custom caller gates are required',async()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'mixed',title:'Dual evidence'}).task.id;
    const spec={taskId,key:'write',command:command('require("node:fs").writeFileSync("report.json",JSON.stringify({total:5,meta:{ok:true}}))'),
      fileCheck:fileSpec,gates:['reviewed']};
    const job=f.rt.submit(spec).job;
    assert.deepEqual(job.gates.map(g=>g.name),['process_exit_zero','local_file_check','reviewed']);
    assert.equal(f.rt.submit(spec).deduplicated,true);
    assert.throws(()=>f.rt.submit({...spec,fileCheck:{path:'other.json',jsonFields:{total:5}}}),/JOB_KEY_PAYLOAD_CONFLICT/);
    assert.throws(()=>f.rt.submit({...spec,fileCheck:null}),/JOB_KEY_PAYLOAD_CONFLICT/);
    f.rt.start({jobId:job.id});
    await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
    f.rt.verifyFile({jobId:job.id});
    assert.throws(()=>f.rt.complete({jobId:job.id}),/COMPLETION_GATES_PENDING/);
    f.rt.passGate({jobId:job.id,name:'reviewed',evidence:'Operator inspected additional outcome'});
    assert.equal(f.rt.complete({jobId:job.id}).job.completionBasis,'local_file_checked_plus_caller_attested');
  } finally {f.cleanup();}
});

test('file check only accepts workspace-relative JSON files and bounded verification contracts',()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'validation',title:'Validation'}).task.id;
    for(const value of [
      {path:'../escaped.json',jsonFields:{status:true}},
      {path:'C:/private.json',jsonFields:{status:true}},
      {path:'missing.json',jsonFields:{}},
      {path:'bad.json',jsonFields:[]},
      {path:'bad.json',jsonFields:'text'},
      {path:'',jsonFields:{status:true}}
    ]) assert.throws(()=>f.rt.submit({taskId,key:'bad'+JSON.stringify(value),command:command(''),fileCheck:value}),/FILE_CHECK_INVALID/);
    assert.throws(()=>f.rt.submit({taskId,key:'badgate',command:command(''),gates:['local_file_check']}),/GATES_INVALID/);
    assert.throws(()=>f.rt.submit({taskId,key:'exitonly',command:command(''),completionMode:'exit_only',fileCheck:fileSpec}),/EXIT_ONLY_DISALLOWS_FILE_CHECK/);
    for(const value of [
      {path:'output.pdf',minBytes:0},
      {path:'output.pdf',minBytes:1.5},
      {path:'output.pdf',minBytes:10,jsonFields:{ok:true}}
    ]) assert.throws(()=>f.rt.submit({taskId,key:'invalid-size'+JSON.stringify(value),command:command(''),fileCheck:value}),/FILE_CHECK_INVALID/);
  } finally {f.cleanup();}
});

test('non-JSON artifact can be checked by minimum file size and is rechecked on completion',async()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'artifact',title:'Generate binary artifact'}).task.id;
    const spec={path:'output.bin',minBytes:12,fresh:true};
    const job=f.rt.submit({taskId,key:'binary',command:command(
      'require("node:fs").writeFileSync("output.bin",Buffer.alloc(24,1))'),fileCheck:spec}).job;
    f.rt.start({jobId:job.id});
    await wait(()=>f.rt.status({jobId:job.id}).job.state==='completion_candidate');
    const result=cliCall(f.root,'verify-file','--job',job.id);
    assert.equal(result.passed,true);
    assert.equal(result.observedBytes,24);
    fs.writeFileSync(path.join(f.root,'output.bin'),Buffer.alloc(3,1));
    assert.throws(()=>f.rt.complete({jobId:job.id}),/FILE_CHECK_TOO_SMALL/);
    fs.writeFileSync(path.join(f.root,'output.bin'),Buffer.alloc(20,1));
    assert.equal(f.rt.complete({jobId:job.id}).job.completionBasis,'local_file_checked');
    assert.equal(f.rt.submit({taskId,key:'binary',command:command(
      'require("node:fs").writeFileSync("output.bin",Buffer.alloc(24,1))'),fileCheck:spec}).deduplicated,true);
  } finally {f.cleanup();}
});

test('size-checked artifact cannot auto-complete when absent or too small',async()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'size-fail',title:'Small file'}).task.id;
    const job=f.rt.submit({taskId,key:'small',command:command(
      'require("node:fs").writeFileSync("small.bin",Buffer.alloc(2))'),
      fileCheck:{path:'small.bin',minBytes:10}}).job;
    const result=await f.rt.drive({taskId,waitMs:5000,pollMs:75});
    assert.ok(result.needsReview.some(j=>j.jobId===job.id && j.reason==='FILE_CHECK_TOO_SMALL'));
    assert.equal(f.rt.status({jobId:job.id}).job.state,'completion_candidate');
  } finally {f.cleanup();}
});
