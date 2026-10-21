#!/usr/bin/env bash
# Bash on Linux/macOS: install the local tarball into a clean consumer workspace.
set -euo pipefail
project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
archive="$(cd "$project" && npm pack --silent --pack-destination "$temp")"
mkdir -p "$temp/consumer"
(cd "$temp/consumer" && npm install --offline --no-audit --no-fund --ignore-scripts --no-save "$temp/$archive")
cli="$temp/consumer/node_modules/.bin/arl"
workspace="$temp/workspace"
cat > "$temp/command.json" <<'JSON'
{"exe":"node","args":["-e","console.log(\"BASH_PACKAGE_DEMO\")"]}
JSON
accepted="$("$cli" accept --root "$workspace" --key bash-demo --title 'Installed Bash consumer')"
task_id="$(node -p 'JSON.parse(process.argv[1]).task.id' "$accepted")"
submitted="$("$cli" submit --root "$workspace" --task "$task_id" --key execute --command-file "$temp/command.json" --gate readback)"
job_id="$(node -p 'JSON.parse(process.argv[1]).job.id' "$submitted")"
"$cli" start --root "$workspace" --job "$job_id" >/dev/null
candidate=''
for ((n=0; n<75; n++)); do
  status="$("$cli" status --root "$workspace" --job "$job_id")"
  state="$(node -p 'JSON.parse(process.argv[1]).job.state' "$status")"
  if [[ "$state" == 'completion_candidate' ]]; then candidate="$status"; break; fi
  if [[ "$state" == 'failed' || "$state" == 'blocked' ]]; then
    echo "Worker failed: $state" >&2
    exit 1
  fi
  sleep 0.12
done
if [[ -z "$candidate" ]]; then echo 'Installed worker timed out' >&2; exit 1; fi
attempt_id="$(node -p 'JSON.parse(process.argv[1]).job.attempts.at(-1).id' "$candidate")"
grep -q 'BASH_PACKAGE_DEMO' "$workspace/.arl/logs/$job_id-$attempt_id.log"
"$cli" gate --root "$workspace" --job "$job_id" --name readback --evidence 'Verified actual child log' >/dev/null
completed="$("$cli" complete --root "$workspace" --job "$job_id")"
[[ "$(node -p 'JSON.parse(process.argv[1]).job.state' "$completed")" == 'completed' ]]
echo BASH_QUICKSTART_PASS
