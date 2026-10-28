import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runtime} from '../src/runtime.mjs';

const wait = async (rt, jobId) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (rt.status({jobId}).job.state === 'completion_candidate') return;
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  throw Error('PLAN_WAIT_TIMEOUT');
};

test('read-only plan gives executable next actions across dependency, evidence and effect states', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-plan-actions-'));
  try {
    const rt = new Runtime(root);
    const taskId = rt.accept({key:'guide',title:'Explain next action'}).task.id;
    const command = {exe:process.execPath, args:['-e',
      "require('node:fs').writeFileSync('result.json',JSON.stringify({ok:true}))"]};
    const a = rt.submit({taskId,key:'make',command,
      fileCheck:{path:'result.json',jsonFields:{ok:true},fresh:true}}).job;
    const b = rt.submit({taskId,key:'deliver',dependsOn:['make'],
      command:{exe:process.execPath,args:['-e','process.exit(0)']}}).job;
    const plan = () => Object.fromEntries(rt.plan({taskId}).jobs.map(j=>[j.key,j]));
    assert.equal(plan().make.nextAction,'run-ready');
    assert.equal(plan().deliver.nextAction,'wait-dependencies');
    assert.equal(plan().deliver.ready,false);
    rt.start({jobId:a.id});
    await wait(rt,a.id);
    assert.equal(plan().make.nextAction,'verify-file');
    rt.verifyFile({jobId:a.id});
    assert.equal(plan().make.nextAction,'complete');
    rt.complete({jobId:a.id});
    assert.equal(plan().make.nextAction,'done');
    assert.equal(plan().deliver.nextAction,'run-ready');
    rt.start({jobId:b.id});
    await wait(rt,b.id);
    rt.beginOperation({jobId:b.id,key:'recipient'});
    assert.equal(plan().deliver.nextAction,'reconcile-operation');
    rt.settleOperation({jobId:b.id,key:'recipient',outcome:'confirmed',evidence:'Verified local test sink'});
    assert.equal(plan().deliver.nextAction,'review-and-gate');
    rt.passGate({jobId:b.id,name:'caller_attestation',evidence:'Output inspected'});
    assert.equal(plan().deliver.nextAction,'complete');
    rt.complete({jobId:b.id});
    assert.equal(plan().deliver.nextAction,'done');
  } finally {
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  }
});
