// The CLI caller ends after each command. A later, independent CLI invocation
// reads the same durable state and validates actual child-process output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-handoff-demo-'));
const bin = path.resolve('bin/arl.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function cli(...args) {
  const r = spawnSync(process.execPath, [bin, ...args], {encoding:'utf8', windowsHide:true, timeout:8000});
  if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr);
  return JSON.parse(r.stdout);
}
const forRoot = (name, ...args) => cli(name, '--root', root, ...args);
console.log('Runtime directory:', root);
const task = forRoot('accept', '--key', 'handoff-demo', '--title', 'Independent CLI caller demo').task;
const command = JSON.stringify({exe:process.execPath,
  args:['-e', 'setTimeout(() => console.log("HANDOFF_OUTPUT_CONFIRMED"), 900)']});
const job = forRoot('submit', '--task', task.id, '--key', 'child',
  '--command', command, '--gate', 'log_reviewed').job;
const launch = forRoot('start', '--job', job.id);
console.log('CLI invocation #1 returned. Worker PID:', launch.workerPid);
let candidate = null;
for (let n=0; n<100; n++) {
  const status = forRoot('status', '--job', job.id).job; // a new CLI process every time
  if (status.state === 'completion_candidate') {candidate=status;break;}
  if (['failed','blocked'].includes(status.state)) throw Error('Worker failed: '+status.blockReason);
  await pause(100);
}
if (!candidate) throw Error('HANDOFF_TIMEOUT');
console.log('New CLI invocations recovered state:', candidate.state);
const before = spawnSync(process.execPath,[bin,'complete','--root',root,'--job',job.id],
  {encoding:'utf8',windowsHide:true});
if (before.status === 0) throw Error('UNVERIFIED_COMPLETION_ALLOWED');
console.log('Unreviewed completion was rejected.');
const attempt = candidate.attempts.at(-1);
const log = fs.readFileSync(path.join(root,'.arl','logs',job.id+'-'+attempt.id+'.log'),'utf8');
if (!log.includes('HANDOFF_OUTPUT_CONFIRMED')) throw Error('ACTUAL_CHILD_OUTPUT_MISSING');
forRoot('gate', '--job', job.id, '--name', 'log_reviewed', '--evidence',
  'Readback of real detached-child stdout log');
forRoot('complete', '--job', job.id);
const final=forRoot('status','--task',task.id);
if (final.task.state !== 'completed' || final.jobs[0].attempts.length !== 1)
  throw Error('HANDOFF_FINAL_STATE_UNEXPECTED');
console.log('Final task state:',final.task.state);
console.log('Worker attempts:',final.jobs[0].attempts.length);
console.log('The original CLI process did not need to remain open.');
