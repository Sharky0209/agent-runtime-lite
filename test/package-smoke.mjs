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
  const installedVersion=JSON.parse(fs.readFileSync(path.join(client,'node_modules','agent-runtime-lite','package.json'),'utf8')).version;
  assert.equal(cli(bin,['--version']),installedVersion);
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
    'import {Runtime} from "agent-runtime-lite"; console.log(typeof Runtime)'],client);
  assert.equal(exported,'function');
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
  const status=JSON.parse(cli(bin,['status','--root',runtimeRoot,'--task',accepted.task.id]));
  assert.equal(status.task.state,'completed');
  assert.equal(status.jobs[0].attempts.length,1);
  const diagnosis=JSON.parse(cli(bin,['doctor','--root',runtimeRoot]));
  assert.equal(diagnosis.counts.jobs,1);
  assert.equal(diagnosis.jobsByState.completed,1);
  assert.equal(diagnosis.counts.reservedResources,0);
  console.log('PACKAGE_INSTALL_PASS',JSON.stringify({
    version:installedVersion,platform:process.platform,cliShim:true,
    exportResolved:true,helpVerified:true,negativeExitCodes:true,
    realChildExecuted:true,evidenceGateEnforced:true,attempts:1}));
} finally {
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
