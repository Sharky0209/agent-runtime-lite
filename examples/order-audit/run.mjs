// Re-run this command to resume a bounded workflow; each root is one input batch.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Runtime, runFlow} from '../../src/runtime.mjs';

const root = path.resolve(process.argv[2] || './.order-audit-state');
fs.mkdirSync(root, {recursive: true});
const input = path.join(root, 'invoices.jsonl');
if (!fs.existsSync(input)) fs.copyFileSync(new URL('./invoices.jsonl', import.meta.url), input);
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const command = step => ({exe: process.execPath, args: [worker, step]});
const manifest = {
  key: 'invoice-reconciliation-v1',
  title: 'Build, independently check, and render an invoice report',
  jobs: [
    {key: 'build', command: command('build'),
      fileCheck: {path: 'audit.json', jsonFields: {status: 'ready'}, fresh: true}},
    {key: 'verify', dependsOn: ['build'], command: command('verify'),
      fileCheck: {path: 'verification.json', jsonFields: {status: 'verified'}, fresh: true}},
    {key: 'render', dependsOn: ['verify'], command: command('render'),
      fileCheck: {path: 'rendered.json', jsonFields: {status: 'rendered'}, fresh: true}}
  ]
};

const runtime = new Runtime(root);
const result = await runFlow(runtime, manifest, {waitMs: 15000, pollMs: 80});
const jobs = runtime.status({taskId: result.taskId}).jobs;
console.log(JSON.stringify({
  taskId: result.taskId,
  taskState: result.taskState,
  deduplicated: result.deduplicated,
  jobs: jobs.map(job => ({key: job.key, state: job.state,
    attempts: job.attempts.length, completionBasis: job.completionBasis || null})),
  output: path.join(root, 'summary.md')
}, null, 2));
if (result.taskState !== 'completed') process.exitCode = 1;
