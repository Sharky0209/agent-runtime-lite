// Self-contained tarball install test: no registry, credentials or production services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-package-smoke-'));
const client = path.join(root,'consumer');
const runtimeRoot = path.join(root,'state');
const isWindows=process.platform==='win32';
fs.mkdirSync(client,{recursive:true});
function run(exe,args,cwd=repo,timeout=60000) {
  const command=exe==='npm' ? process.execPath : exe;
  const actualArgs=exe==='npm' ? [process.env.npm_execpath, ...args] : args;
  if (exe==='npm' && !process.env.npm_execpath) throw Error('RUN_WITH_NPM_SCRIPT_REQUIRED');
  const result=spawnSync(command,actualArgs,{cwd,encoding:'utf8',timeout,windowsHide:true,
    env:{...process.env,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}});
  if (result.error || result.status!==0)
    throw Error(`FAILED ${exe} ${args.slice(0,3).join(' ')}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const cli=(bin,args) => run(process.execPath,[bin,...args],client,10000);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const pack=JSON.parse(run('npm',['pack','--json','--pack-destination',root]))[0];
  const included=pack.files.map(f=>f.path);
  for(const required of ['package.json','LICENSE','bin/arl.mjs','src/runtime.mjs','src/worker.mjs'])
    assert.ok(included.includes(required),'missing from archive: '+required);
  assert.ok(!included.some(p=>p.startsWith('.arl/')||p.startsWith('test/')||p.endsWith('.env')));
  const tarball=path.join(root,pack.filename);
  run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-save',tarball],client);
  const bin=path.join(client,'node_modules','agent-runtime-lite','bin','arl.mjs');
  const npmShim=path.join(client,'node_modules','.bin',isWindows?'arl.cmd':'arl');
  assert.ok(fs.existsSync(npmShim),'npm CLI shim missing');
  const help=run('npm',['exec','--offline','--','arl','--help'],client);
  assert.match(help,/--command-file/);
  assert.match(help,/submit/);
  assert.match(help,/arl demo/);
  assert.match(help,/run-ready/);
  assert.match(help,/verify-file/);
  assert.match(help,/arl flow/);
  const installedVersion=JSON.parse(fs.readFileSync(path.join(client,'node_modules','agent-runtime-lite','package.json'),'utf8')).version;
  assert.equal(cli(bin,['--version']),installedVersion);
  // This runs the real detached worker and separate CLI callers from the installed package.
  // It is the friction-free first action advertised to prospective users.
  assert.match(cli(bin,['demo']),/DEMO_REAL_FILE_READBACK_PASS/);
  const emptyDiagnosis=JSON.parse(cli(bin,['doctor','--root',runtimeRoot]));
  assert.equal(emptyDiagnosis.initialized,false);
  assert.equal(emptyDiagnosis.counts.jobs,0);
  const invalid=spawnSync(process.execPath,[bin,'unknown-command'],
    {cwd:client,encoding:'utf8',windowsHide:true});
  assert.equal(invalid.status,1);
  assert.match(invalid.stderr,/UNKNOWN_COMMAND/);
  const missing=spawnSync(process.execPath,[bin,'accept','--root',runtimeRoot],
    {cwd:client,encoding:'utf8',windowsHide:true});
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/MISSING --key/);
  const exported=run(process.execPath,['--input-type=module','-e',
    'import {Runtime,runFlow,ChatContinuationGuard} from "agent-runtime-lite"; console.log([Runtime,runFlow,ChatContinuationGuard].map(v=>typeof v).join(","))'],client);
  assert.equal(exported,'function,function,function');
  const accepted=JSON.parse(cli(bin,['accept','--root',runtimeRoot,'--key','package-test',
    '--title','Separate consumer']));
  const commandFile=path.join(client,'command.json');
  fs.writeFileSync(commandFile,JSON.stringify({
    exe:process.execPath,args:['-e','console.log("ISOLATED_PACKAGE_OUTPUT")']
  }));
  const submitted=JSON.parse(cli(bin,['submit','--root',runtimeRoot,'--task',accepted.task.id,
    '--key','run','--command-file',commandFile]));
  const jobId=submitted.job.id;
  assert.equal(submitted.job.completionMode,'attested');
  assert.ok(submitted.job.gates.some(g=>g.name==='caller_attestation'&&!g.passed));
  const beforeStart=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--job',jobId]));
  assert.equal(beforeStart.job.state,'queued');
  JSON.parse(cli(bin,['start','--root',runtimeRoot,'--job',jobId]));
  let candidate;
  for(let i=0;i<100;i++){
    const current=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--job',jobId])).job;
    if (current.state==='completion_candidate') {candidate=current;break;}
    if (current.state==='failed'||current.state==='blocked')
      throw Error('Installed worker failed: '+current.blockReason);
    await pause(70);
  }
  assert.ok(candidate,'installed CLI did not reach completion candidate');
  const denied=spawnSync(process.execPath,[bin,'complete','--root',runtimeRoot,'--job',jobId],
    {cwd:client,encoding:'utf8',windowsHide:true});
  assert.equal(denied.status,1);
  assert.match(denied.stderr,/COMPLETION_GATES_PENDING/);
  const attempt=candidate.attempts.at(-1);
  const log=fs.readFileSync(path.join(runtimeRoot,'.arl','logs',jobId+'-'+attempt.id+'.log'),'utf8');
  assert.match(log,/ISOLATED_PACKAGE_OUTPUT/);
  JSON.parse(cli(bin,['gate','--root',runtimeRoot,'--job',jobId,'--name','caller_attestation',
    '--evidence','Independent installed-package CLI caller inspected real output']));
  const completed=JSON.parse(cli(bin,['complete','--root',runtimeRoot,'--job',jobId]));
  assert.equal(completed.job.state,'completed');
  assert.equal(completed.job.completionBasis,'caller_attested');
  // Verify the new workflow command from the installed, not source, CLI.
  const dependent=JSON.parse(cli(bin,['submit','--root',runtimeRoot,'--task',accepted.task.id,
    '--key','follow-up','--command-file',commandFile,'--depends-on','["run"]'])).job;
  assert.deepEqual(dependent.dependsOn,['run']);
  const readiness=JSON.parse(cli(bin,['plan','--root',runtimeRoot,'--task',accepted.task.id]));
  assert.equal(readiness.jobs.find(job=>job.jobId===dependent.id).ready,true);
  const batch=JSON.parse(cli(bin,['run-ready','--root',runtimeRoot,'--task',accepted.task.id]));
  assert.equal(batch.started.length,1);
  assert.equal(batch.started[0].jobId,dependent.id);
  let next;
  for(let i=0;i<100;i++){
    const current=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--job',dependent.id])).job;
    if (current.state==='completion_candidate') {next=current;break;}
    if (current.state==='failed'||current.state==='blocked') throw Error('Dependent worker failed: '+current.blockReason);
    await pause(70);
  }
  assert.ok(next,'installed dependent worker did not reach completion candidate');
  const nextAttempt=next.attempts.at(-1);
  assert.match(fs.readFileSync(path.join(runtimeRoot,'.arl','logs',dependent.id+'-'+nextAttempt.id+'.log'),'utf8'),
    /ISOLATED_PACKAGE_OUTPUT/);
  JSON.parse(cli(bin,['gate','--root',runtimeRoot,'--job',dependent.id,'--name','caller_attestation',
    '--evidence','Follow-up installed child log independently checked']));
  JSON.parse(cli(bin,['complete','--root',runtimeRoot,'--job',dependent.id]));
  // The installed package must read and verify actual JSON fields without
  // taking a caller's unverifiable evidence string as the file check.
  const checkedCommand=path.join(client,'verified-command.json');
  fs.writeFileSync(checkedCommand,JSON.stringify({exe:process.execPath,
    args:['-e','require("node:fs").writeFileSync("checked.json",JSON.stringify({items:2,total:5,extra:true}))']}));
  const checked=JSON.parse(cli(bin,['submit','--root',runtimeRoot,'--task',accepted.task.id,
    '--key','checked-file','--command-file',checkedCommand,'--depends-on','["follow-up"]',
    '--file-check','{"path":"checked.json","jsonFields":{"total":5,"items":2}}'])).job;
  assert.deepEqual(checked.gates.map(g=>g.name),['process_exit_zero','local_file_check']);
  const checkedStarted=JSON.parse(cli(bin,['run-ready','--root',runtimeRoot,'--task',accepted.task.id]));
  assert.equal(checkedStarted.started.length,1);
  assert.equal(checkedStarted.started[0].jobId,checked.id);
  let checkedCandidate;
  for(let i=0;i<100;i++){
    const current=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--job',checked.id])).job;
    if (current.state==='completion_candidate') {checkedCandidate=current;break;}
    if (current.state==='failed'||current.state==='blocked') throw Error('Installed file-check worker failed: '+current.blockReason);
    await pause(70);
  }
  assert.ok(checkedCandidate,'installed file-check child did not reach completion candidate');
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot,'checked.json'),'utf8')).total,5);
  const checkedReadback=JSON.parse(cli(bin,['verify-file','--root',runtimeRoot,'--job',checked.id]));
  assert.equal(checkedReadback.checkedFields,2);
  assert.equal(checkedReadback.gate.source,'runtime_local_file_readback');
  assert.equal(JSON.parse(cli(bin,['complete','--root',runtimeRoot,'--job',checked.id])).job.completionBasis,
    'local_file_checked');
  const status=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--task',accepted.task.id]));
  assert.equal(status.task.state,'completed');
  assert.equal(status.jobs.length,3);
  assert.ok(status.jobs.every(job=>job.attempts.length===1));
  const diagnosis=JSON.parse(cli(bin,['doctor','--root',runtimeRoot]));
  assert.equal(diagnosis.counts.jobs,3);
  assert.equal(diagnosis.jobsByState.completed,3);
  assert.equal(diagnosis.counts.reservedResources,0);
  // Installed one-command declarative import + evidence-checked progression.
  const manifestFile=path.join(client,'flow.json');
  const flowRoot=path.join(root,'declarative-state');
  fs.writeFileSync(manifestFile,JSON.stringify({key:'installed-flow',title:'Packaged flow',jobs:[
    {key:'make',command:{exe:process.execPath,args:['-e',
      'require("node:fs").writeFileSync("one.json",JSON.stringify({total:3}))']},
      fileCheck:{path:'one.json',jsonFields:{total:3}}},
    {key:'follow',dependsOn:['make'],command:{exe:process.execPath,args:['-e',
      'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync("one.json","utf8"));fs.writeFileSync("two.json",JSON.stringify({total:x.total+2}))']},
      fileCheck:{path:'two.json',jsonFields:{total:5}}}
  ]}));
  const flowed=JSON.parse(cli(bin,['flow','--root',flowRoot,'--flow-file',manifestFile,
    '--wait-ms','12000','--poll-ms','80']));
  assert.equal(flowed.taskState,'completed');
  assert.equal(flowed.autoCompleted.length,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(flowRoot,'two.json'),'utf8')).total,5);
  const secondFlow=JSON.parse(cli(bin,['flow','--root',flowRoot,'--flow-file',manifestFile,
    '--wait-ms','0']));
  assert.equal(secondFlow.deduplicated,true);
  assert.deepEqual(secondFlow.started,[]);
  assert.ok(secondFlow.jobs.every(item => {
    const result=JSON.parse(cli(bin,['status','--root',flowRoot,'--job',item.jobId]));
    return result.job.attempts.length===1;
  }));
  console.log('PACKAGE_INSTALL_PASS',JSON.stringify({
    version:installedVersion,platform:process.platform,cliShim:true,
    exportResolved:true,helpVerified:true,negativeExitCodes:true,
    realChildExecuted:true,evidenceGateEnforced:true,workflowDependency:true,verifiedFile:true,declarativeFlow:true,attempts:3}));
} finally {
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
