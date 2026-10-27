// Declarative, resumable single-host workflow entrypoint.
// Submission is keyed and durable; a repeat import reuses existing jobs.
export async function runFlow(runtime, manifest, {waitMs = 10000, pollMs = 100} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      typeof manifest.key !== 'string' || !manifest.key.trim() ||
      typeof manifest.title !== 'string' || !manifest.title.trim() ||
      !Array.isArray(manifest.jobs) || !manifest.jobs.length) {
    throw Error('FLOW_MANIFEST_INVALID');
  }
  const seen = new Set();
  for (const step of manifest.jobs) {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        typeof step.key !== 'string' || !step.key.trim() ||
        !step.command || typeof step.command.exe !== 'string' ||
        !Array.isArray(step.command.args) ||
        !step.command.args.every(item => typeof item === 'string') ||
        (step.dependsOn != null && (!Array.isArray(step.dependsOn) ||
          !step.dependsOn.every(key => typeof key === 'string' && seen.has(key))))) {
      throw Error('FLOW_STEP_INVALID');
    }
    if (seen.has(step.key)) throw Error('FLOW_DUPLICATE_JOB');
    seen.add(step.key);
  }
  // Validation precedes any state mutation. Each submit uses its existing
  // immutable idempotency contract so interrupted imports can be repeated.
  const accepted = runtime.accept({key: manifest.key,title: manifest.title,goal: manifest.goal || ''});
  const jobs = [];
  for (const step of manifest.jobs) {
    const {job} = runtime.submit({...step,taskId:accepted.task.id});
    jobs.push({key:step.key,jobId:job.id});
  }
  const result = await runtime.drive({taskId:accepted.task.id,waitMs,pollMs});
  return {taskId:accepted.task.id,deduplicated:accepted.deduplicated,jobs,...result};
}
