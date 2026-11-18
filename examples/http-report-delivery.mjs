// Runnable HTTP delivery adapter. PUT is the effect; GET is the independent readback.
// Supply ARL_HTTP_URL and an optional ARL_HTTP_TOKEN for your own recipient service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Runtime} from '../src/runtime.mjs';

const script = fileURLToPath(import.meta.url);

async function deliver() {
  const root = process.env.ARL_ROOT;
  const jobId = process.env.ARL_JOB_ID;
  const url = process.env.ARL_HTTP_URL;
  if (!url) throw Error('ARL_HTTP_URL_REQUIRED');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
  const headers = {'content-type': 'application/json'};
  if (process.env.ARL_HTTP_TOKEN) headers.authorization = 'Bearer ' + process.env.ARL_HTTP_TOKEN;

  // The reservation precedes any network write. A previously reserved operation
  // can be read back, but is never sent again by this worker.
  const reserved = new Runtime(root).beginOperation({jobId, key: 'publish-report'});
  if (!reserved.deduplicated) {
    const sent = await fetch(url, {
      method: 'PUT', headers, body: JSON.stringify(report), signal: AbortSignal.timeout(10000)
    });
    if (!sent.ok) throw Error('REPORT_PUT_FAILED:' + sent.status);
  }

  const response = await fetch(url, {headers, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('REPORT_GET_FAILED:' + response.status);
  const received = await response.json();
  if (!isDeepStrictEqual(received, report)) throw Error('REMOTE_READBACK_MISMATCH');

  new Runtime(root).settleOperation({
    jobId, key: 'publish-report', outcome: 'confirmed',
    evidence: 'Recipient GET returned the exact submitted JSON document'
  });
  fs.writeFileSync(path.join(root, 'delivery.json'),
    JSON.stringify({verified: true, reportId: report.reportId}));
}

export async function runReport(root, waitMs = 12000) {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
  if (typeof report.reportId !== 'string' || !report.reportId.trim()) {
    throw Error('REPORT_ID_REQUIRED');
  }
  const runtime = new Runtime(root);
  const {task} = runtime.accept({
    key: 'http-report:' + report.reportId,
    title: 'Deliver and verify report ' + report.reportId
  });
  const {job} = runtime.submit({
    taskId: task.id,
    key: 'publish',
    command: {exe: process.execPath, args: [script, '--worker']},
    resources: ['report-endpoint:' + report.reportId],
    fileCheck: {path: 'delivery.json',
      jsonFields: {verified: true, reportId: report.reportId}, fresh: true}
  });
  const result = await runtime.drive({taskId: task.id, waitMs});
  const current = runtime.status({jobId: job.id}).job;
  return {
    taskId: task.id, jobId: job.id, taskState: result.taskState,
    jobState: current.state, completionBasis: current.completionBasis || null,
    operationState: current.operations[0]?.state || null, attempts: current.attempts.length
  };
}

// A real loopback HTTP receiver for automated integration tests. It verifies
// network PUT + GET, but makes no claim about a third-party production service.
export async function runDemo({mismatch = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-http-report-'));
  let stored = null;
  let putCount = 0;
  const server = createServer(async (req, res) => {
    if (req.url !== '/reports/weekly') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const part of req) body += part;
      stored = JSON.parse(body);
      putCount++;
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && stored) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(mismatch ? {...stored, status: 'stale'} : stored));
      return;
    }
    res.writeHead(404).end();
  });
  const previous = process.env.ARL_HTTP_URL;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.ARL_HTTP_URL = 'http://127.0.0.1:' + server.address().port + '/reports/weekly';
    fs.writeFileSync(path.join(root, 'report.json'),
      JSON.stringify({reportId: 'weekly-operations-example', status: 'ready', count: 3}));
    const result = await runReport(root);
    return {...result, putCount};
  } finally {
    if (previous === undefined) delete process.env.ARL_HTTP_URL;
    else process.env.ARL_HTTP_URL = previous;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === '--worker') await deliver();
    else {
      const result = process.argv[2] === '--run'
        ? await runReport(path.resolve(process.argv[3] || '.'))
        : await runDemo({mismatch: process.argv.includes('--mismatch')});
      console.log(JSON.stringify(result));
      if (result.taskState !== (process.argv.includes('--mismatch') ? 'blocked' : 'completed')) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
