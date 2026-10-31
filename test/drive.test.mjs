import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';

const make=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arl-drive-'));
  return {root, rt:new Runtime(root), cleanup:()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:12,retryDelay:150})};
};
const cmd=script=>({exe:process.execPath,args:['-e',script]});
const file=(name, fields)=>({path:name,jsonFields:fields});
const report=(name, obj)=>'require("node:fs").writeFileSync('+JSON.stringify(name)+',JSON.stringify('+JSON.stringify(obj)+'))';
const cli=path.resolve('bin/arl.mjs');
const cliRun=(root,...args)=>{
  const out=spawnSync(process.execPath,[cli,args[0],'--root',root,...args.slice(1)],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(out.status,0,out.stderr||out.error?.message);
  return JSON.parse(out.stdout);
};

test('drive executes and independently confirms two dependent local-output jobs from one CLI invocation',()=>{
  const f=make();
  try {
    const task=f.rt.accept({key:'chain',title:'Real two-stage chain'}).task;
    const a=f.rt.submit({taskId:task.id,key:'produce',
      command:cmd(report('first.json',{done:1})),fileCheck:file('first.json',{done:1})}).job;
    const b=f.rt.submit({taskId:task.id,key:'consume',dependsOn:['produce'],
      command:cmd('const fs=require("node:fs");const first=JSON.parse(fs.readFileSync("first.json","utf8"));fs.writeFileSync("second.json",JSON.stringify({answer:first.done+1}))'),
      fileCheck:file('second.json',{answer:2})}).job;
    const result=cliRun(f.root,'drive','--task',task.id,'--wait-ms','12000','--poll-ms','80');
    assert.equal(result.timedOut,false);
    assert.equal(result.taskState,'completed');
    assert.deepEqual(new Set(result.autoCompleted),new Set([a.id,b.id]));
    assert.equal(result.started.length,2);
    assert.deepEqual(result.needsReview,[]);
    assert.equal(f.rt.status({jobId:a.id}).job.completionBasis,'local_file_checked');
    assert.equal(f.rt.status({jobId:b.id}).job.completionBasis,'local_file_checked');
    assert.equal(f.rt.status({jobId:b.id}).job.attempts.length,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'second.json'),'utf8')).answer,2);
    const again=cliRun(f.root,'drive','--task',task.id,'--wait-ms','0');
    assert.deepEqual(again.started,[]);
    assert.deepEqual(again.autoCompleted,[]);
    assert.equal(again.taskState,'completed');
  } finally {f.cleanup();}
});

test('driver revisits a completion candidate observed after its first scheduling snapshot',async()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'transition',title:'Transition'}).task.id;
    let rounds=0;
    const base={taskId,autoCompleted:[],started:[],waiting:[],needsReview:[],active:[],failed:[]};
    f.rt.advance=()=>++rounds===1
      ? {...base,taskState:'validating',autoPending:['late-candidate']}
      : {...base,taskState:'completed',autoPending:[]};
    const result=await f.rt.drive({taskId,waitMs:1000,pollMs:50});
    assert.equal(result.taskState,'completed');
    assert.equal(result.timedOut,false);
    assert.equal(rounds,2);
  } finally {f.cleanup();}
});

test('a manual candidate emerging during dispatch is surfaced for review',()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'late-manual',title:'Late manual candidate'}).task.id;
    const job=f.rt.submit({taskId,key:'checked-and-reviewed',command:cmd('process.exit(0)'),
      fileCheck:file('report.json',{ok:true}),gates:['review']}).job;
    // Deterministically model an already-launched worker reaching candidate
    // between the first status snapshot and the final status read.
    f.rt.runReady=()=>{
      f.rt.store.update(state=>{
        const row=state.jobs[job.id];
        row.state='completion_candidate';
        row.gates.find(g=>g.name==='process_exit_zero').passed=true;
      });
      return {started:[],waiting:[]};
    };
    const round=f.rt.advance({taskId});
    assert.equal(round.taskState,'validating');
    assert.deepEqual(round.autoPending,[]);
    assert.deepEqual(round.needsReview,[{jobId:job.id,reason:'CALLER_EVIDENCE_REQUIRED'}]);
  } finally {f.cleanup();}
});

test('drive stops at a manual evidence boundary and does not launch downstream',async()=>{
  const f=make();
  try {
    const task=f.rt.accept({key:'manual',title:'Requires operator review'}).task;
    const a=f.rt.submit({taskId:task.id,key:'produce',command:cmd(report('manual.json',{total:3})),
      fileCheck:file('manual.json',{total:3}),gates:['business_review']}).job;
    const b=f.rt.submit({taskId:task.id,key:'after',dependsOn:['produce'],
      command:cmd(report('after.json',{ready:true})),fileCheck:file('after.json',{ready:true})}).job;
    const first=await f.rt.drive({taskId:task.id,waitMs:8000,pollMs:70});
    assert.equal(first.timedOut,false);
    assert.deepEqual(first.autoCompleted,[]);
    assert.ok(first.needsReview.some(x=>x.jobId===a.id && x.reason==='CALLER_EVIDENCE_REQUIRED'));
    assert.equal(f.rt.status({jobId:b.id}).job.attempts.length,0);
    assert.equal(fs.existsSync(path.join(f.root,'after.json')),false);
    f.rt.verifyFile({jobId:a.id});
    f.rt.passGate({jobId:a.id,name:'business_review',evidence:'Operator independently reviewed business output'});
    f.rt.complete({jobId:a.id});
    const second=await new Runtime(f.root).drive({taskId:task.id,waitMs:8000,pollMs:70});
    assert.equal(second.taskState,'completed');
    assert.deepEqual(second.autoCompleted,[b.id]);
  } finally {f.cleanup();}
});

test('drive refuses a mismatched local report even after child exit code zero',async()=>{
  const f=make();
  try {
    const task=f.rt.accept({key:'mismatch',title:'Wrong report'}).task;
    const a=f.rt.submit({taskId:task.id,key:'wrong',command:cmd(report('bad.json',{total:4})),
      fileCheck:file('bad.json',{total:5})}).job;
    const b=f.rt.submit({taskId:task.id,key:'after',dependsOn:['wrong'],
      command:cmd(report('later.json',{ok:true})),fileCheck:file('later.json',{ok:true})}).job;
    const result=await f.rt.drive({taskId:task.id,waitMs:8000,pollMs:60});
    assert.equal(result.timedOut,false);
    assert.ok(result.needsReview.some(x=>x.jobId===a.id && x.reason==='FILE_CHECK_CONTENT_MISMATCH'));
    assert.equal(f.rt.status({jobId:a.id}).job.state,'completion_candidate');
    assert.equal(f.rt.status({jobId:b.id}).job.attempts.length,0);
    assert.equal(fs.existsSync(path.join(f.root,'later.json')),false);
    assert.equal(result.taskState,'validating');
  } finally {f.cleanup();}
});

test('drive will not settle a job with unresolved external operations',async()=>{
  const f=make();
  try {
    const task=f.rt.accept({key:'ops',title:'External operation unresolved'}).task;
    const a=f.rt.submit({taskId:task.id,key:'one',command:cmd(report('report.json',{ok:true})),
      fileCheck:file('report.json',{ok:true})}).job;
    f.rt.start({jobId:a.id});
    const begin=Date.now();
    while(f.rt.status({jobId:a.id}).job.state!=='completion_candidate') {
      if(Date.now()-begin>9000) throw Error('WAIT_TIMEOUT');
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    f.rt.beginOperation({jobId:a.id,key:'external-write'});
    const result=await f.rt.drive({taskId:task.id,waitMs:500,pollMs:50});
    assert.deepEqual(result.autoCompleted,[]);
    assert.ok(result.needsReview.some(x=>x.jobId===a.id && x.reason==='OPERATION_RECONCILIATION_REQUIRED'));
    assert.equal(f.rt.status({jobId:a.id}).job.state,'completion_candidate');
  } finally {f.cleanup();}
});

test('single manifest command imports, verifies and resumes a real two-step workflow',()=>{
  const f=make();
  try {
    const manifest={
      key:'portable-flow',title:'One command flow',jobs:[
        {key:'generate',command:cmd(report('one.json',{number:5})),
          fileCheck:file('one.json',{number:5})},
        {key:'transform',dependsOn:['generate'],
          command:cmd('const fs=require("node:fs");const v=JSON.parse(fs.readFileSync("one.json","utf8"));fs.writeFileSync("two.json",JSON.stringify({number:v.number*2}))'),
          fileCheck:file('two.json',{number:10})}
      ]
    };
    const manifestPath=path.join(f.root,'flow.json');
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    const first=cliRun(f.root,'flow','--flow-file',manifestPath,'--wait-ms','12000','--poll-ms','70');
    assert.equal(first.taskState,'completed');
    assert.equal(first.deduplicated,false);
    assert.equal(first.autoCompleted.length,2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'two.json'),'utf8')).number,10);
    const again=cliRun(f.root,'flow','--flow-file',manifestPath,'--wait-ms','0');
    assert.equal(again.deduplicated,true);
    assert.equal(again.taskId,first.taskId);
    assert.deepEqual(again.started,[]);
    assert.deepEqual(again.autoCompleted,[]);
    assert.ok(again.jobs.every(item=>f.rt.status({jobId:item.jobId}).job.attempts.length===1));
  } finally {f.cleanup();}
});

test('the checked-in public example really runs on this platform',()=>{
  const f=make();
  try {
    const result=cliRun(f.root,'flow','--flow-file',path.resolve('examples/verified-workflow.json'),
      '--wait-ms','12000','--poll-ms','80');
    assert.equal(result.taskState,'completed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'report.json'),'utf8')),
      {items:2,total:5});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'summary.json'),'utf8')),
      {total:5});
  } finally {f.cleanup();}
});

test('manifest rejects forward references before creating a task',()=>{
  const f=make();
  try {
    const invalid=path.join(f.root,'bad-flow.json');
    fs.writeFileSync(invalid,JSON.stringify({key:'bad',title:'bad',jobs:[
      {key:'second',dependsOn:['first'],command:cmd('process.exit(0)')},
      {key:'first',command:cmd('process.exit(0)')}
    ]}));
    const failed=spawnSync(process.execPath,[cli,'flow','--root',f.root,'--flow-file',invalid],
      {encoding:'utf8',windowsHide:true,timeout:8000});
    assert.equal(failed.status,1);
    assert.match(failed.stderr,/FLOW_STEP_INVALID/);
    assert.equal(fs.existsSync(path.join(f.root,'.arl','state.json')),false);
  } finally {f.cleanup();}
});

test('flow-check previews new and existing jobs without creating state or launching children',()=>{
  const f=make();
  try {
    const manifest={key:'preview',title:'Preview',jobs:[
      {key:'first',command:cmd(report('would-run.json',{ok:true}))},
      {key:'second',dependsOn:['first'],command:cmd('process.exit(0)')}
    ]};
    const manifestPath=path.join(f.root,'preview.json');
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    const first=cliRun(f.root,'flow-check','--flow-file',manifestPath);
    assert.equal(first.valid,true);
    assert.equal(first.taskAction,'create');
    assert.deepEqual(first.jobs.map(j=>j.action),['create','create']);
    assert.equal(fs.existsSync(path.join(f.root,'.arl')),false);
    assert.equal(fs.existsSync(path.join(f.root,'would-run.json')),false);
    const taskId=f.rt.accept({key:'preview',title:'Preview'}).task.id;
    f.rt.submit({taskId,...manifest.jobs[0]});
    const before=fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8');
    const again=cliRun(f.root,'flow-check','--flow-file',manifestPath);
    assert.equal(again.taskAction,'reuse');
    assert.deepEqual(again.jobs.map(j=>j.action),['reuse','create']);
    assert.equal(fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8'),before);
  } finally {f.cleanup();}
});

test('invalid late flow step does not persist earlier jobs or start a worker',()=>{
  const f=make();
  try {
    const manifest={key:'late-error',title:'Late error',jobs:[
      {key:'first',command:cmd(report('should-not-run.json',{ok:true}))},
      {key:'second',dependsOn:['first'],command:cmd('process.exit(0)'),
        resume:'auto_safe',readOnly:false}
    ]};
    const flowFile=path.join(f.root,'flow-invalid.json');
    fs.writeFileSync(flowFile,JSON.stringify(manifest));
    const failed=spawnSync(process.execPath,[cli,'flow','--root',f.root,'--flow-file',flowFile],
      {encoding:'utf8',windowsHide:true,timeout:8000});
    assert.equal(failed.status,1);
    assert.match(failed.stderr,/AUTO_RECOVERY_REQUIRES_READ_ONLY/);
    assert.equal(fs.existsSync(path.join(f.root,'.arl','state.json')),false);
    assert.equal(fs.existsSync(path.join(f.root,'should-not-run.json')),false);
  } finally {f.cleanup();}
});

test('flow preflight catches an existing immutable job conflict before importing later steps',()=>{
  const f=make();
  try {
    const taskId=f.rt.accept({key:'existing',title:'Existing flow'}).task.id;
    f.rt.submit({taskId,key:'first',command:cmd('process.exit(0)')});
    const manifest={key:'existing',title:'Existing flow',jobs:[
      {key:'new',command:cmd('process.exit(0)')},
      {key:'first',command:cmd('process.exit(9)')}
    ]};
    const manifestPath=path.join(f.root,'existing.json');
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    const before=fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8');
    const failed=spawnSync(process.execPath,[cli,'flow','--root',f.root,'--flow-file',manifestPath],
      {encoding:'utf8',windowsHide:true,timeout:8000});
    assert.equal(failed.status,1);
    assert.match(failed.stderr,/JOB_KEY_PAYLOAD_CONFLICT/);
    assert.equal(fs.readFileSync(path.join(f.root,'.arl','state.json'),'utf8'),before);
    assert.equal(f.rt.status({taskId}).jobs.length,1);
  } finally {f.cleanup();}
});

test('drive rejects unbounded wait and leaves unrelated tasks untouched',async()=>{
  const f=make();
  try {
    const first=f.rt.accept({key:'one',title:'One'}).task;
    const second=f.rt.accept({key:'two',title:'Two'}).task;
    f.rt.submit({taskId:second.id,key:'not-owned',command:cmd('process.exit(0)')});
    const result=await f.rt.drive({taskId:first.id,waitMs:0});
    assert.equal(result.taskState,'active');
    assert.equal(f.rt.status({taskId:second.id}).jobs[0].state,'queued');
    await assert.rejects(f.rt.drive({taskId:first.id,waitMs:120000}),/DRIVE_WAIT_INVALID/);
    await assert.rejects(f.rt.drive({taskId:first.id,pollMs:0}),/DRIVE_POLL_INVALID/);
    await assert.rejects(f.rt.drive({taskId:'nope'}),/TASK_NOT_FOUND/);
  } finally {f.cleanup();}
});
