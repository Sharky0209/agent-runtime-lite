import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Runtime, ChatContinuationGuard} from '../src/runtime.mjs';

const fixture = () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arl-chat-'));
  let now=Date.parse('2026-10-27T00:00:00Z');
  const rt=new Runtime(root);
  const taskId=rt.accept({key:'resume',title:'Long chat task'}).task.id;
  const newGuard=()=>new ChatContinuationGuard(root,{now:()=>now});
  const guard=newGuard();
  const keys={taskId,conversationId:'pinned-chat',turnId:'turn-1'};
  const watch=(options={})=>guard.watch({...keys,continuationMessage:'继续之前已授权的任务，先读回已完成部分；不要重复外部操作。',stallMs:30000,...options});
  const advance=ms=>{now+=ms;};
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  return {guard,newGuard,keys,taskId,watch,advance,cleanup};
};
const adapter=(turnStatus='timed_out')=>{
  const sent=[];
  return {
    capabilities:{atomicHeadCheck:true,durableIdempotency:true},
    sent,
    async readTurn({conversationId,turnId}){
      return {conversationId,turnId,status:turnStatus,headMatches:true,hasNewerMessages:false,headId:'head-1'};
    },
    async sendContinuation(payload){sent.push(payload);return {messageId:'response-1'};},
    async readDelivery({conversationId,operationKey}){
      return {conversationId,operationKey,status:'confirmed',messageId:'response-1'};
    }
  };
};

test('lack of progress is only a suspicion; actively thinking turns are not interrupted',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.guard.observe({...f.keys,sequence:1,status:'active',progressKey:'initial-token'});
    f.advance(60000);
    assert.equal(f.guard.plan(f.keys).reason,'suspected_stall');
    const live=adapter('active');
    assert.deepEqual(await f.guard.tick(f.keys,live),{action:'none',reason:'PROVIDER_NOT_TERMINAL'});
    assert.equal(live.sent.length,0);
    assert.equal(f.guard.status(f.keys).dispatch,null);
    f.guard.observe({...f.keys,sequence:2,status:'active',progressKey:'new-actual-progress'});
    assert.equal(f.guard.plan(f.keys).reason,'active');
    // Ordinary repeated polling isn't actual generation progress.
    f.advance(32000);
    f.guard.observe({...f.keys,sequence:3,status:'active',progressKey:'new-actual-progress'});
    assert.equal(f.guard.plan(f.keys).reason,'suspected_stall');
  } finally {f.cleanup();}
});

test('confirmed failed turn emits a single continuation and independently reconciles delivery',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.guard.observe({...f.keys,sequence:1,status:'timed_out'});
    const conn=adapter();
    const result=await f.guard.tick(f.keys,conn);
    assert.equal(result.action,'submitted_unverified');
    assert.equal(result.dispatch.state,'submitted_unverified');
    assert.equal(result.dispatch.receipt.messageId,'response-1');
    assert.equal(conn.sent.length,1);
    assert.deepEqual(Object.keys(conn.sent[0]).sort(),
      ['conversationId','expectedHeadId','message','operationKey','turnId'].sort());
    assert.equal(conn.sent[0].expectedHeadId,'head-1');
    assert.equal((await f.newGuard().tick(f.keys,conn)).reason,'submitted_unverified');
    assert.equal(conn.sent.length,1,'restarting cannot duplicate the message');
    const verified=await f.newGuard().reconcile(f.keys,conn);
    assert.equal(verified.status,'confirmed');
    assert.equal(f.guard.plan(f.keys).reason,'confirmed');
  } finally {f.cleanup();}
});

test('network timeout before receipt cannot trigger a replay even after process restart',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.guard.observe({...f.keys,sequence:1,status:'failed'});
    const conn=adapter('failed');
    conn.sendContinuation=async body=>{conn.sent.push(body);throw Error('socket timeout');};
    assert.equal((await f.guard.tick(f.keys,conn)).action,'uncertain');
    assert.equal(f.guard.status(f.keys).dispatch.state,'reserved_uncertain');
    assert.equal((await f.newGuard().tick(f.keys,conn)).reason,'reserved_uncertain');
    assert.equal(conn.sent.length,1);
    conn.readDelivery=async({conversationId,operationKey})=>
      ({conversationId,operationKey,status:'absent'});
    assert.equal((await f.newGuard().reconcile(f.keys,conn)).status,'UNCERTAIN_NO_RESEND');
    assert.equal(conn.sent.length,1);
  } finally {f.cleanup();}
});

test('concurrent watchdogs share one durable dispatch claim',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.guard.observe({...f.keys,sequence:1,status:'interrupted'});
    const conn=adapter('interrupted');
    const results=await Promise.all([f.guard.tick(f.keys,conn),f.newGuard().tick(f.keys,conn)]);
    assert.equal(results.filter(x=>x.action==='submitted_unverified').length,1);
    assert.equal(conn.sent.length,1);
  } finally {f.cleanup();}
});

test('provider identity, head and actual final response always veto resending',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.advance(31000);
    const cases=[
      [{conversationId:'wrong',turnId:'turn-1',status:'failed',headMatches:true,headId:'head',hasNewerMessages:false},'IDENTITY_UNVERIFIED'],
      [{...f.keys,status:'active',headMatches:true,headId:'head',hasNewerMessages:false},'PROVIDER_NOT_TERMINAL'],
      [{...f.keys,status:'completed',headMatches:true,headId:'head',hasNewerMessages:false},'ALREADY_ADVANCED'],
      [{...f.keys,status:'failed',headMatches:false,headId:'head',hasNewerMessages:false},'PROVIDER_NOT_TERMINAL'],
      [{...f.keys,status:'failed',headMatches:true,headId:'head',hasNewerMessages:true},'ALREADY_ADVANCED'],
      [{...f.keys,status:'failed',headMatches:true,headId:'head',hasNewerMessages:false},null]
    ];
    for (const [read,reason] of cases.slice(0,-1)) {
      const conn=adapter();
      conn.readTurn=async()=>read;
      assert.equal((await f.guard.tick(f.keys,conn)).reason,reason);
      assert.equal(conn.sent.length,0);
    }
    const noCas=adapter('failed');
    delete noCas.capabilities.atomicHeadCheck;
    assert.equal((await f.guard.tick(f.keys,noCas)).reason,'PROVIDER_ATOMIC_SEND_UNAVAILABLE');
    assert.equal(noCas.sent.length,0);
    const noIdempotency=adapter('failed');
    noIdempotency.capabilities.durableIdempotency=false;
    assert.equal((await f.guard.tick(f.keys,noIdempotency)).reason,'PROVIDER_ATOMIC_SEND_UNAVAILABLE');
    assert.equal(noIdempotency.sent.length,0);
  } finally {f.cleanup();}
});

test('stale/double observations cannot reset a completed turn or change immutable watch policy',async()=>{
  const f=fixture();
  try {
    f.watch();
    assert.equal(f.watch().deduplicated,true);
    assert.throws(()=>f.watch({stallMs:31000}),/CHAT_WATCH_PAYLOAD_CONFLICT/);
    f.guard.observe({...f.keys,sequence:7,status:'completed'});
    f.guard.observe({...f.keys,sequence:6,status:'failed'});
    f.guard.observe({...f.keys,sequence:8,status:'failed'});
    assert.equal(f.guard.plan(f.keys).reason,'completed');
    f.advance(40000);
    const conn=adapter('failed');
    assert.equal((await f.guard.tick(f.keys,conn)).reason,'completed');
    assert.equal(conn.sent.length,0);
  } finally {f.cleanup();}
});

test('per-task continuation ceiling prevents endless stop-and-restart loops',async()=>{
  const f=fixture();
  try {
    f.watch({maxContinuationsPerTask:1});
    f.guard.observe({...f.keys,sequence:1,status:'failed'});
    const conn=adapter('failed');
    assert.equal((await f.guard.tick(f.keys,conn)).action,'submitted_unverified');
    const second={...f.keys,turnId:'turn-2'};
    f.guard.watch({...second,continuationMessage:'继续并检查前轮结果',stallMs:30000,
      maxContinuationsPerTask:1});
    f.guard.observe({...second,sequence:1,status:'failed'});
    conn.readTurn=async({conversationId,turnId})=>({
      conversationId,turnId,status:'failed',headMatches:true,hasNewerMessages:false,headId:'head-2'
    });
    assert.equal((await f.guard.tick(second,conn)).reason,'TASK_CONTINUATION_LIMIT');
    assert.equal(conn.sent.length,1);
  } finally {f.cleanup();}
});

test('Chat CLI records progress and emits a read-only plan without sending anything',()=>{
  const f=fixture();
  try {
    const msg=path.join(f.guard.store.root,'continue.txt');
    fs.writeFileSync(msg,'继续未完成任务；先核对操作回执');
    const cli=path.resolve('bin/arl.mjs');
    const call=(...args)=>{
      const output=spawnSync(process.execPath,[cli,...args,'--root',f.guard.store.root,
        '--task',f.taskId,'--conversation',f.keys.conversationId,'--turn',f.keys.turnId],
      {encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(output.status,0,output.stderr);
      return JSON.parse(output.stdout);
    };
    assert.equal(call('chat-watch','--message-file',msg,'--stall-ms','30000').deduplicated,false);
    assert.equal(call('chat-observe','--sequence','1','--state','active','--progress-key','visible-1').deduplicated,false);
    assert.equal(call('chat-plan').reason,'active');
    assert.equal(f.guard.status(f.keys).dispatch,null);
  } finally {f.cleanup();}
});

test('mismatched readback message ID never confirms an unrelated chat submission',async()=>{
  const f=fixture();
  try {
    f.watch();
    f.guard.observe({...f.keys,sequence:1,status:'failed'});
    const conn=adapter('failed');
    await f.guard.tick(f.keys,conn);
    conn.readDelivery=async({conversationId,operationKey})=>({
      conversationId,operationKey,status:'confirmed',messageId:'someone-else'
    });
    assert.equal((await f.guard.reconcile(f.keys,conn)).status,'UNCERTAIN_NO_RESEND');
    assert.equal(f.guard.status(f.keys).dispatch.state,'submitted_unverified');
  } finally {f.cleanup();}
});

test('task identity and observation inputs are strict',()=>{
  const f=fixture();
  try {
    assert.throws(()=>f.guard.watch({...f.keys,taskId:'unknown',continuationMessage:'继续'}),/TASK_NOT_FOUND/);
    assert.throws(()=>f.watch({stallMs:1000}),/CHAT_POLICY_INVALID/);
    f.watch();
    assert.throws(()=>f.guard.observe({...f.keys,sequence:-1,status:'active'}),/CHAT_OBSERVATION_INVALID/);
    assert.throws(()=>f.guard.observe({...f.keys,sequence:1,status:'imagined'}),/CHAT_OBSERVATION_INVALID/);
  } finally {f.cleanup();}
});
