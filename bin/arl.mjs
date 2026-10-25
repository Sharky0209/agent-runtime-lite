#!/usr/bin/env node
import {readFileSync} from 'node:fs';
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
const json = (value) => JSON.parse(value.replace(/^\uFEFF/, ''));
const commandInput = () => {
  if (parsed.command && parsed['command-file']) throw Error('ONLY_ONE_COMMAND_SOURCE');
  if (parsed['command-file']) return json(readFileSync(arg('command-file'), 'utf8'));
  return json(arg('command'));
};
const gateNames = () => {
  if (parsed.gate && parsed.gates) throw Error('ONLY_ONE_GATE_SOURCE');
  return parsed.gate ? [arg('gate')] : parsed.gates ? json(arg('gates')) : [];
};
const root = typeof parsed.root === 'string' ? parsed.root : process.cwd();
const runtime = new Runtime(root);
const command = parsed._[0];
const routes = {
  accept: () => runtime.accept({key: arg('key'), title: arg('title'), goal: parsed.goal || ''}),
  submit: () => runtime.submit({
    taskId: arg('task'), key: arg('key'), command: commandInput(),
    resources: parsed.resources ? json(parsed.resources) : [],
    gates: gateNames(),
    readOnly: parsed['read-only'] === true,
    resume: parsed.resume || 'manual',
    maxRestarts: Number(parsed.restarts || 0),
    timeoutMs: Number(parsed.timeout || 0),
    completionMode: parsed['completion-mode'] || 'attested'
  }),
  start: () => runtime.start({jobId: arg('job')}),
  retry: () => runtime.retry({jobId: arg('job')}),
  recover: () => runtime.recover(),
  status: () => runtime.status({taskId: parsed.task, jobId: parsed.job}),
  doctor: () => runtime.diagnose(),
  checkpoint: () => runtime.checkpoint({taskId: arg('task'), step: arg('step'), note: parsed.note || ''}),
  'op-begin': () => runtime.beginOperation({jobId: arg('job'), key: arg('key')}),
  'op-confirm': () => runtime.settleOperation({jobId: arg('job'), key: arg('key'), outcome:'confirmed', evidence:arg('evidence')}),
  'op-abort': () => runtime.settleOperation({jobId: arg('job'), key: arg('key'), outcome:'aborted', evidence:arg('evidence')}),
  gate: () => runtime.passGate({jobId: arg('job'), name: arg('name'), evidence: arg('evidence')}),
  complete: () => runtime.complete({jobId: arg('job')})
};
const usage = `Agent Runtime Lite
Usage: arl <command> [options]

Commands: accept, submit, start, status, checkpoint, op-begin,
          op-confirm, op-abort, gate, complete, retry, recover, doctor, demo

Global:   --root <directory>  Select a local state directory
Doctor:   arl doctor --root ./state  (read-only, share-safe counts)
Demo:     arl demo  Run a disposable real-file handoff and verification
          --help, help        Print this help
          --version, version  Print installed version

Submit:   --task <id> --key <name>
          --command <JSON>  OR  --command-file <JSON file>
          --gate <name>     OR  --gates <JSON array>
          --resources <JSON array>  (optional)
          --completion-mode attested|exit_only  (default: attested)
          Default: caller must pass --name caller_attestation with evidence
          exit_only: explicit, unverified process-exit semantics (no --gate)

Example:  arl accept --root ./demo --key hello --title Hello
Docs:     https://github.com/Sharky0209/agent-runtime-lite`;
try {
  if (parsed.help === true || command === 'help') console.log(usage);
  else if (command === 'demo') {
    const {runDemo} = await import('../src/demo.mjs');
    await runDemo();
  } else if (parsed.version === true || command === 'version') {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else {
    if (!routes[command]) throw Error('UNKNOWN_COMMAND: ' + String(command) + '\n' + usage);
    console.log(JSON.stringify(routes[command](), null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({error: error.message}));
  process.exitCode = 1;
}
