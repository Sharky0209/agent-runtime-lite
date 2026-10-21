import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runtime} from '../src/runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lite-demo-'));
const runtime = new Runtime(root);
const {task} = runtime.accept({key:'hello-demo',title:'Run and verify a child command'});
const {job} = runtime.submit({
  taskId: task.id,
  key:'say-hello',
  command: {exe: process.execPath, args:['-e','console.log("Agent Runtime Lite demo")']},
  gates:['output_reviewed'],
  resources:['demo:output']
});
runtime.checkpoint({taskId:task.id,step:'command_created',note:'Ready to run'});
console.log('Runtime data:',root);
console.log('Started:',runtime.start({jobId:job.id}));
let candidate = false;
for (let i = 0; i < 100; i++) {
  const current = new Runtime(root).status({jobId:job.id}).job;
  if (current.state === 'completion_candidate') {candidate=true;break;}
  if (current.state === 'failed' || current.state === 'blocked') throw Error('Demo worker failed: '+current.blockReason);
  await new Promise(resolve => setTimeout(resolve,100));
}
if (!candidate) throw Error('Demo timeout');
const attempt = runtime.status({jobId: job.id}).job.attempts.at(-1);
const text = fs.readFileSync(path.join(root,'.arl','logs',job.id+'-'+attempt.id+'.log'),'utf8');
if (!text.includes('Agent Runtime Lite demo')) throw Error('Demo output was not found');
runtime.passGate({jobId:job.id,name:'output_reviewed',evidence:'Verified actual child log output'});
runtime.complete({jobId:job.id});
const result=runtime.status({taskId:task.id});
console.log('Final task state:',result.task.state);
console.log('Final job state:',result.jobs[0].state);
