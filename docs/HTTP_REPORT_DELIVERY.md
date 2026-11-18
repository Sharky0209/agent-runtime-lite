# Verified HTTP report delivery

A practical application of Agent Runtime Lite: **publish a JSON report to an HTTP service, read the stored result back from that service, and only then mark the job complete.**

This is a runnable adapter example built on the existing `Runtime` API, not a new built-in HTTP transport or a generic webhook sender.

## What it does

1. Read `report.json` from a local task workspace.
2. Reserve the external `publish-report` operation before sending anything.
3. Send the report with HTTP `PUT`.
4. Perform an independent HTTP `GET` against the same resource and compare the full JSON document.
5. Confirm the operation, write a local `delivery.json` receipt, and let the runtime validate that receipt before completing the job.

If the remote readback does not match, the job fails and the operation remains `uncertain`. A successful HTTP response to `PUT` alone is **not** treated as proof of delivery.

## Try it locally

Node.js 20+; no credentials, npm dependencies, or external service required:

```sh
npm run demo:http
node --test test/http-report-delivery.test.mjs
```

The demonstration runs a **real loopback HTTP server** and child process. It performs a network `PUT` followed by a separate `GET`. The negative test deliberately makes the receiver return the wrong content; completion must be rejected.

This is transport-level integration evidence against a local receiver, **not** a claim that an actual third-party service has been tested.

## Connect your own receiving service

The example expects one resource URL supporting the following contract:

| Request | Required response |
| --- | --- |
| `PUT /reports/{id}` with a JSON document | Successful 2xx, persisted as a replacement for this report ID |
| `GET /reports/{id}` | 200 with **exactly the same JSON document** (not a wrapper or summary) |

Repeated `PUT` to the same report resource must be safe. The receiving service should make new writes visible to its subsequent `GET` before the job can be considered delivered.

Create a **dedicated workspace for each report** and place its source file at `report.json`:

```json
{
  "reportId": "weekly-2026-11-18",
  "status": "ready",
  "count": 3
}
```

For Bash:

```sh
export ARL_HTTP_URL="https://your-service.example/reports/weekly-2026-11-18"
export ARL_HTTP_TOKEN="YOUR_SERVICE_TOKEN"
node examples/http-report-delivery.mjs --run ./my-report-workspace
```

For PowerShell:

```powershell
$env:ARL_HTTP_URL = "https://your-service.example/reports/weekly-2026-11-18"
$env:ARL_HTTP_TOKEN = "YOUR_SERVICE_TOKEN"
node examples/http-report-delivery.mjs --run ./my-report-workspace
```

Set the token only if the service requires Bearer authentication. Configure the environment in the caller or its trusted process manager; **do not put tokens into the CLI command JSON, source files, or issue reports**.

The `--run` command returns the durable task/job IDs, task state, operation state, and completion basis. Invoke the same command again to continue a still-running job; the stable `reportId` prevents a completed job from being sent again. Treat a given report ID and its input document as immutable. For a changed report, create a new report ID and workspace.

The report delivery adapter lives in [`examples/http-report-delivery.mjs`](../examples/http-report-delivery.mjs). Replace its HTTP protocol only if your service has different write/read APIs; keep `beginOperation`, destination readback, `settleOperation`, and file verification in the same order.

## Handling uncertainty

When a request fails after the operation is reserved, **do not immediately resend**: the receiver may already have stored the report. Read the receiver directly first.

- If its `GET` returns the exact intended document, confirm the operation using `arl op-confirm --root ... --job JOB_ID --key publish-report --evidence "..." `, then explicitly retry the failed job. On retry this adapter skips the network write and rechecks the receiver before producing its local receipt.
- If the report is missing or different, leave the job blocked until you determine what the remote system actually applied. A new delivery can be submitted with a new report ID/workspace after review; this example does not automatically replay uncertain writes.

Only a verified remote document allows the operation to be confirmed. The local `delivery.json` file is evidence that this adapter performed the readback, not a permanent guarantee about future remote state.

## Framework boundaries

This example uses existing runtime capabilities: durable keyed task/job state, detached worker execution, operation reservation, explicit reconciliation, local file gate, and one-shot `drive()`. It does not add a hosted service, distributed scheduler, arbitrary webhook support, or remote exactly-once guarantees.

**中文概要：** 这是一个可以直接运行的 HTTP 报告交付实例：本地生成 `report.json`，向接收端 `PUT`，再用 `GET` 读取实际保存的 JSON；内容完全一致才完成。接收端返回不一致或网络结果未知时，不自动重复发送。附带本地 HTTP 服务的正反向集成测试；实际生产接收端需要自行配置 `ARL_HTTP_URL`。
