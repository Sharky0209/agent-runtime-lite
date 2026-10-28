// A complete local-sink integration: the worker uses runtime-provided context
// to record an external-effect intent, read back a recipient receipt, and settle it.
// In a real integration, replace the local inbox with the recipient's read API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/runtime.mjs';

const script = fileURLToPath(import.meta.url);

if (process.argv[2] === '--worker') {
  const {ARL_ROOT: root, ARL_JOB_ID: jobId, ARL_ATTEMPT_ID: attemptId} = process.env;
  const runtime = new Runtime(root);
  const reserved = runtime.beginOperation({jobId, key: 'deliver-local-receipt'});
  if (reserved.deduplicated && reserved.operation.state === 'uncertain') {
    throw Error('DELIVERY_UNKNOWN_REVIEW_REQUIRED');
  }
  if (!reserved.deduplicated) {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox, {recursive: true});
    const delivered = {received: true, attemptId};
    fs.writeFileSync(path.join(inbox, 'receipt.json'), JSON.stringify(delivered));
    const readback = JSON.parse(fs.readFileSync(path.join(inbox, 'receipt.json'), 'utf8'));
    if (readback.received !== true || readback.attemptId !== attemptId) {
      throw Error('RECEIPT_READBACK_MISMATCH');
    }
    runtime.settleOperation({jobId, key: 'deliver-local-receipt',
      outcome: 'confirmed', evidence: 'Local receiver receipt read back and matched'});
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({status: 'ready', delivered: true}));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-integration-'));
  try {
    const runtime = new Runtime(root);
    const {task} = runtime.accept({key: 'local-delivery-demo', title: 'Deliver and verify a local receipt'});
    const {job} = runtime.submit({
      taskId: task.id, key: 'deliver',
      command: {exe: process.execPath, args: [script, '--worker']},
      fileCheck: {path: 'result.json', jsonFields: {status: 'ready', delivered: true}, fresh: true},
      resources: ['local-recipient']
    });
    const run = await runtime.drive({taskId: task.id, waitMs: 12000});
    if (run.taskState !== 'completed') throw Error('INTEGRATION_INCOMPLETE:' + JSON.stringify(run));
    const settled = runtime.status({jobId: job.id}).job;
    if (settled.operations[0]?.state !== 'confirmed') throw Error('DELIVERY_NOT_CONFIRMED');
    console.log(JSON.stringify({taskState: run.taskState,
      completionBasis: settled.completionBasis,
      receiverConfirmed: true, attempts: settled.attempts.length}));
  } finally {
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 150});
  }
}
