// First-run demo for an independently installed CLI.
// All state and output stay in a disposable temp workspace; no network or user data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runDemo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-installed-demo-'));
  const bin = fileURLToPath(new URL('../bin/arl.mjs', import.meta.url));
  const reportPath = path.join(root, 'report.json');
  let success = false;
  const invoke = (action, args = [], expectFailure = false) => {
    // A fresh executable/process for every call; not the module runtime in memory.
    const result = spawnSync(process.execPath, [bin, action, '--root', root, ...args],
      {encoding: 'utf8', windowsHide: true, timeout: 12000});
    if (result.error) throw result.error;
    if (expectFailure) {
      if (result.status !== 1 || !result.stderr.includes('COMPLETION_GATES_PENDING')) {
        throw Error('DEMO_EXPECTED_UNVERIFIED_COMPLETION_REJECTION');
      }
      return;
    }
    if (result.status !== 0) {
      throw Error('DEMO_CLI_' + action.toUpperCase() + '_FAILED: ' + (result.stderr || result.status));
    }
    return JSON.parse(result.stdout);
  };
  try {
    const {task} = invoke('accept', ['--key', 'first-run', '--title', 'Produce and verify a report']);
    const program = [
      'const fs=require("node:fs");',
      'const report={items:[{name:"alpha",count:2},{name:"beta",count:3}],total:5};',
      'fs.writeFileSync(' + JSON.stringify(reportPath) + ',JSON.stringify(report));'
    ].join('');
    const {job} = invoke('submit', ['--task', task.id, '--key', 'produce',
      '--command', JSON.stringify({exe: process.execPath, args: ['-e', program]})]);
    if (job.completionMode !== 'attested' ||
      !job.gates.some(g => g.name === 'caller_attestation' && !g.passed)) {
      throw Error('DEMO_DEFAULT_ATTESTATION_MISSING');
    }
    invoke('start', ['--job', job.id]);
    console.log('1/4 Detached child started. The original CLI command exited.');
    let candidate = null;
    for (let i = 0; i < 90; i++) {
      const {job: observed} = invoke('status', ['--job', job.id]);
      if (observed.state === 'completion_candidate') {candidate = observed; break;}
      if (['failed', 'blocked'].includes(observed.state)) {
        throw Error('DEMO_CHILD_FAILED: ' + (observed.blockReason || observed.state));
      }
      await sleep(100);
    }
    if (!candidate) throw Error('DEMO_CHILD_TIMEOUT');
    invoke('complete', ['--job', job.id], true);
    console.log('2/4 Completion without evidence: REJECTED.');
    if (!fs.existsSync(reportPath)) throw Error('DEMO_REPORT_MISSING');
    // Verification is done in this new caller, not by the child that wrote the file.
    const raw = fs.readFileSync(reportPath, 'utf8');
    const report = JSON.parse(raw);
    if (!Array.isArray(report.items) || report.items.length !== 2 ||
      report.items[0]?.name !== 'alpha' || report.items[0]?.count !== 2 ||
      report.items[1]?.name !== 'beta' || report.items[1]?.count !== 3 ||
      report.total !== report.items.reduce((sum, item) => sum + item.count, 0) ||
      report.total !== 5) {
      throw Error('DEMO_REPORT_READBACK_FAILED');
    }
    const sha = createHash('sha256').update(raw).digest('hex');
    console.log('3/4 Independent file readback: PASS (2 rows, total 5).');
    invoke('gate', ['--job', job.id, '--name', 'caller_attestation',
      '--evidence', 'Read report.json and verified 2 rows, total 5; SHA256=' + sha]);
    const finished = invoke('complete', ['--job', job.id]);
    const {task: last, jobs} = invoke('status', ['--task', task.id]);
    if (finished.job.completionBasis !== 'caller_attested' ||
      last.state !== 'completed' || jobs.length !== 1 || jobs[0].attempts.length !== 1 ||
      finished.job.completionBasis !== jobs[0].completionBasis) {
      throw Error('DEMO_FINAL_READBACK_FAILED');
    }
    console.log('4/4 Result: completed, caller_attested, 1 worker attempt.');
    console.log('DEMO_REAL_FILE_READBACK_PASS');
    success = true;
  } finally {
    if (success) {
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 8, retryDelay: 150});
    } else {
      // Retain failed-test state for private diagnosis: cleaning a live child
      // workspace can cause more damage than leaving a small temp directory.
      console.error('Demo failed; isolated workspace retained for investigation: ' + root);
    }
  }
}
