// A realistic local deliverable: produce report.json in a detached child, then
// inspect it from a new CLI invocation before declaring the task completed.
// Node.js 20+, no registry installation, network, API key or cloud account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-report-demo-'));
const reportPath = path.join(root, 'report.json');
const bin = path.resolve('bin/arl.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function invoke(action, ...args) {
  const result = spawnSync(process.execPath, [bin, action, '--root', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw Error('CLI ' + action + ': ' + (result.error?.message || result.stderr));
  }
  return JSON.parse(result.stdout);
}
function expectRejected(action, ...args) {
  const result = spawnSync(process.execPath, [bin, action, '--root', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status === 0) {
    throw Error('Premature completion was not rejected');
  }
}

const {task} = invoke('accept', '--key', 'weekly-report', '--title', 'Generate a checked report');
const childScript = [
  'const fs = require("node:fs");',
  'const report = {week:"2026-W43", items:[{name:"alpha",count:2},{name:"beta",count:3}], total:5};',
  `setTimeout(() => fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report, null, 2)), 500);`,
].join('\n');
const {job} = invoke('submit', '--task', task.id, '--key', 'generate-json',
  '--command', JSON.stringify({exe: process.execPath, args: ['-e', childScript]}),
  '--gate', 'report_file_checked');
invoke('start', '--job', job.id);
console.log('Detached report job started. The first CLI invocation has ended.');

let candidate;
for (let i = 0; i < 100; i++) {
  const {job: current} = invoke('status', '--job', job.id);
  if (current.state === 'completion_candidate') {candidate = current; break;}
  if (current.state === 'failed' || current.state === 'blocked') {
    throw Error('Worker did not complete: ' + (current.blockReason || current.state));
  }
  await pause(100);
}
if (!candidate) throw Error('Timed out waiting for the report candidate');
console.log('Fresh CLI invocation reports:', candidate.state);
expectRejected('complete', '--job', job.id);
console.log('Completion rejected before checking the deliverable.');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const sum = report.items.reduce((value, row) => value + row.count, 0);
if (report.week !== '2026-W43' || sum !== report.total || sum !== 5) {
  throw Error('Report content did not pass independent readback');
}
console.log('Independent report file readback: PASS (' + report.items.length + ' rows, total ' + sum + ')');
invoke('gate', '--job', job.id, '--name', 'report_file_checked',
  '--evidence', 'Read report.json from filesystem, verified week, rows and sum');
invoke('complete', '--job', job.id);
const result = invoke('status', '--task', task.id);
if (result.task.state !== 'completed' || result.jobs[0].attempts.length !== 1) {
  throw Error('Unexpected final job state or duplicate attempt');
}
console.log('Final task state:', result.task.state);
console.log('Worker attempts:', result.jobs[0].attempts.length);
console.log('Generated report:', reportPath);
