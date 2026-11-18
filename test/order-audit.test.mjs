import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const example = fileURLToPath(new URL('../examples/order-audit/run.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../examples/order-audit/worker.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../examples/order-audit/invoices.jsonl', import.meta.url));
const run = root => spawnSync(process.execPath, [example, root],
  {encoding: 'utf8', timeout: 30000, windowsHide: true});

test('order audit runs three checked stages and never reruns completed jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-order-audit-'));
  try {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const result = JSON.parse(first.stdout);
    assert.equal(result.taskState, 'completed');
    assert.deepEqual(result.jobs.map(job => job.key), ['build', 'verify', 'render']);
    assert.deepEqual(result.jobs.map(job => job.attempts), [1, 1, 1]);
    assert.ok(result.jobs.every(job => job.completionBasis === 'local_file_checked'));
    const audit = JSON.parse(fs.readFileSync(path.join(root, 'audit.json'), 'utf8'));
    assert.deepEqual(audit, {
      status: 'ready', invoiceCount: 4, paidCount: 3, totalCents: 20575, paidCents: 16025
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'verification.json'), 'utf8')).status, 'verified');
    assert.match(fs.readFileSync(path.join(root, 'summary.md'), 'utf8'), /Paid amount: 160\.25/);
    const second = run(root);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const resumed = JSON.parse(second.stdout);
    assert.equal(resumed.taskId, result.taskId);
    assert.equal(resumed.deduplicated, true);
    assert.deepEqual(resumed.jobs.map(job => job.attempts), [1, 1, 1]);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('invalid input blocks the workflow without producing downstream artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-order-invalid-'));
  try {
    const source = fs.readFileSync(fixture, 'utf8').trim();
    fs.writeFileSync(path.join(root, 'invoices.jsonl'),
      source + '\n' + source.split('\n')[0] + '\n');
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).taskState, 'blocked');
    assert.equal(fs.existsSync(path.join(root, 'verification.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'summary.md')), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('independent verification rejects a tampered intermediate report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-order-tampered-'));
  try {
    fs.copyFileSync(fixture, path.join(root, 'invoices.jsonl'));
    const env = {...process.env, ARL_ROOT: root};
    assert.equal(spawnSync(process.execPath, [worker, 'build'],
      {encoding: 'utf8', env, windowsHide: true}).status, 0);
    const audit = JSON.parse(fs.readFileSync(path.join(root, 'audit.json'), 'utf8'));
    audit.paidCents++;
    fs.writeFileSync(path.join(root, 'audit.json'), JSON.stringify(audit));
    const verified = spawnSync(process.execPath, [worker, 'verify'],
      {encoding: 'utf8', env, windowsHide: true});
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /AUDIT_READBACK_MISMATCH/);
    assert.equal(fs.existsSync(path.join(root, 'verification.json')), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
