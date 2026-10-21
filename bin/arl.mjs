#!/usr/bin/env node
import {Runtime} from '../src/runtime.mjs';

const parsed = {_: []};
for (let n = 2; n < process.argv.length; n++) {
  const value = process.argv[n];
  if (!value.startsWith('--')) {parsed._.push(value); continue;}
  const name = value.slice(2);
  const next = process.argv[n + 1];
  if (!next || next.startsWith('--')) parsed[name] = true;
  else {parsed[name] = next; n++;}
}
const arg = (key) => {
  if (!parsed[key] || parsed[key] === true) throw Error('MISSING --' + key);
  return parsed[key];
};
const json = (value) => JSON.parse(value);
const root = typeof parsed.root === 'string' ? parsed.root : process.cwd();
const runtime = new Runtime(root);
const command = parsed._[0];
const routes = {
  accept: () => runtime.accept({key: arg('key'), title: arg('title'), goal: parsed.goal || ''}),
  submit: () => runtime.submit({
    taskId: arg('task'), key: arg('key'), command: json(arg('command')),
    resources: parsed.resources ? json(parsed.resources) : [],
    gates: parsed.gates ? json(parsed.gates) : [],
    readOnly: parsed['read-only'] === true,
    resume: parsed.resume || 'manual',
    maxRestarts: Number(parsed.restarts || 0),
    timeoutMs: Number(parsed.timeout || 0)
  }),
  start: () => runtime.start({jobId: arg('job')}),
  retry: () => runtime.retry({jobId: arg('job')}),
  recover: () => runtime.recover(),
  status: () => runtime.status({taskId: parsed.task, jobId: parsed.job}),
  checkpoint: () => runtime.checkpoint({taskId: arg('task'), step: arg('step'), note: parsed.note || ''}),
  'op-begin': () => runtime.beginOperation({jobId: arg('job'), key: arg('key')}),
  'op-confirm': () => runtime.settleOperation({jobId: arg('job'), key: arg('key'), outcome:'confirmed', evidence:arg('evidence')}),
  'op-abort': () => runtime.settleOperation({jobId: arg('job'), key: arg('key'), outcome:'aborted', evidence:arg('evidence')}),
  gate: () => runtime.passGate({jobId: arg('job'), name: arg('name'), evidence: arg('evidence')}),
  complete: () => runtime.complete({jobId: arg('job')})
};
try {
  if (!routes[command]) throw Error('USAGE: arl <accept|submit|start|status|checkpoint|op-begin|op-confirm|op-abort|gate|complete|retry|recover> [--root directory] ...');
  console.log(JSON.stringify(routes[command](), null, 2));
} catch (error) {
  console.error(JSON.stringify({error: error.message}));
  process.exitCode = 1;
}
