# Windows PowerShell 5.1+ / pwsh 7+: installs the local package in isolation.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("arl-ps-install-" + [guid]::NewGuid().ToString('N'))
$consumer = Join-Path $temp 'consumer'
$workspace = Join-Path $temp 'workspace'
$commandFile = Join-Path $temp 'command.json'
New-Item -ItemType Directory -Path $consumer -Force | Out-Null
try {
  Push-Location $project
  try {
    $archive = (& npm pack --silent --pack-destination $temp | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or -not $archive) { throw 'npm pack failed' }
  } finally { Pop-Location }
  Push-Location $consumer
  try {
    & npm install --offline --no-audit --no-fund --ignore-scripts --no-save (Join-Path $temp $archive)
    if ($LASTEXITCODE -ne 0) { throw 'Offline local tarball install failed' }
  } finally { Pop-Location }
  $cli = Join-Path $consumer 'node_modules/.bin/arl.cmd'
  if (-not (Test-Path $cli)) { throw 'Installed arl.cmd not found' }
  $spec = @{exe = (Get-Command node).Source; args = @('-e', 'console.log("POWERSHELL_PACKAGE_DEMO")')}
  $spec | ConvertTo-Json -Compress | Set-Content -Path $commandFile -Encoding UTF8
  $accepted = (& $cli accept --root $workspace --key 'ps-demo' --title 'Installed PowerShell consumer' | Out-String | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $accepted.task.id) { throw 'Task creation failed' }
  $submitted = (& $cli submit --root $workspace --task $accepted.task.id --key 'execute' --command-file $commandFile --gate readback | Out-String | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $submitted.job.id) { throw 'Job submission failed' }
  $jobId = $submitted.job.id
  & $cli start --root $workspace --job $jobId | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Worker launch failed' }
  $candidate = $null
  for ($i=0; $i -lt 75; $i++) {
    $status = (& $cli status --root $workspace --job $jobId | Out-String | ConvertFrom-Json)
    if ($status.job.state -eq 'completion_candidate') { $candidate = $status.job; break }
    if ($status.job.state -in @('failed','blocked')) { throw "Worker failed: $($status.job.blockReason)" }
    Start-Sleep -Milliseconds 120
  }
  if ($null -eq $candidate) { throw 'Timeout waiting for installed worker' }
  $attemptId = $candidate.attempts[-1].id
  $logFile = Join-Path $workspace ".arl/logs/$jobId-$attemptId.log"
  if (-not ((Get-Content -Raw -Path $logFile) -match 'POWERSHELL_PACKAGE_DEMO')) { throw 'Actual child output missing' }
  & $cli gate --root $workspace --job $jobId --name readback --evidence 'Read and verified actual child log' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Evidence gate failed' }
  $completed = (& $cli complete --root $workspace --job $jobId | Out-String | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $completed.job.state -ne 'completed') { throw 'Job completion failed' }
  Write-Output 'POWERSHELL_QUICKSTART_PASS'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
