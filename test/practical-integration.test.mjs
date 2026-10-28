import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Runtime} from '../src/runtime.mjs';

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-practical-'));
  return {root, rt: new Runtime(root),
    cleanup: () => fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 150})};
};
const wait = async (rt, jobId, state) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (rt.status({jobId}).job.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  throw Error('JOB_WAIT_TIMEOUT:' + state);
};

test('fresh file check rejects an old matching report while preserving the legacy default', async () => {
  const f = fixture();
  try {
    const report = path.join(f.root, 'result.json');
    fs.writeFileSync(report, JSON.stringify({status: 'ready'}));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(report, old, old);
    const taskId = f.rt.accept({key: 'fresh-check', title: 'Reject stale reports'}).task.id;
    const command = {exe: process.execPath, args: ['-e', 'process.exit(0)']};
    const spec = {path: 'result.json', jsonFields: {status: 'ready'}, fresh: true};
    const freshJob = f.rt.submit({taskId, key: 'fresh', command, fileCheck: spec}).job;
    assert.equal(f.rt.submit({taskId, key: 'fresh', command, fileCheck: spec}).deduplicated, true);
    assert.throws(() => f.rt.submit({taskId, key: 'fresh', command,
      fileCheck: {path: 'result.json', jsonFields: {status: 'ready'}}}), /JOB_KEY_PAYLOAD_CONFLICT/);
    f.rt.start({jobId: freshJob.id});
    await wait(f.rt, freshJob.id, 'completion_candidate');
    assert.throws(() => f.rt.verifyFile({jobId: freshJob.id}), /FILE_CHECK_STALE/);
    const result = f.rt.advance({taskId});
    assert.ok(result.needsReview.some(row => row.jobId === freshJob.id && row.reason === 'FILE_CHECK_STALE'));
    assert.equal(f.rt.status({jobId: freshJob.id}).job.state, 'completion_candidate');

    const legacy = f.rt.submit({taskId, key: 'compatible', command,
      fileCheck: {path: 'result.json', jsonFields: {status: 'ready'}}}).job;
    f.rt.start({jobId: legacy.id});
    await wait(f.rt, legacy.id, 'completion_candidate');
    assert.equal(f.rt.verifyFile({jobId: legacy.id}).passed, true);
    assert.equal(f.rt.complete({jobId: legacy.id}).job.completionBasis, 'local_file_checked');
  } finally { f.cleanup(); }
});

test('fresh file check accepts a report modified during the current attempt', async () => {
  const f = fixture();
  try {
    const report = path.join(f.root, 'result.json');
    fs.writeFileSync(report, JSON.stringify({status: 'ready'}));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(report, old, old);
    const taskId = f.rt.accept({key: 'refresh', title: 'Write current report'}).task.id;
    const job = f.rt.submit({taskId, key: 'write',
      command: {exe: process.execPath, args: ['-e',
        "require('node:fs').writeFileSync('result.json',JSON.stringify({status:'ready'}))"]},
      fileCheck: {path: 'result.json', jsonFields: {status: 'ready'}, fresh: true}}).job;
    const result = await f.rt.drive({taskId, waitMs: 10000});
    assert.equal(result.taskState, 'completed');
    assert.equal(f.rt.status({jobId: job.id}).job.attempts.length, 1);
    assert.equal(f.rt.status({jobId: job.id}).job.completionBasis, 'local_file_checked');
    assert.throws(() => f.rt.submit({taskId,key:'invalid', command:{exe:'node',args:[]},
      fileCheck: {path:'result.json',jsonFields:{status:'ready'},fresh:'yes'}}), /FILE_CHECK_INVALID/);
  } finally { f.cleanup(); }
});

test('published example demonstrates actual worker context and confirmed local receipt', () => {
  const example = path.resolve('examples/integrated-job.mjs');
  const out = spawnSync(process.execPath, [example], {
    encoding: 'utf8', windowsHide: true, timeout: 18000
  });
  assert.equal(out.status, 0, out.stderr || out.error?.message);
  const result = JSON.parse(out.stdout.trim());
  assert.equal(result.taskState, 'completed');
  assert.equal(result.completionBasis, 'local_file_checked');
  assert.equal(result.receiverConfirmed, true);
  assert.equal(result.attempts, 1);
});
