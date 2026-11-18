import test from 'node:test';
import assert from 'node:assert/strict';
import {runDemo} from '../examples/http-report-delivery.mjs';

test('HTTP report delivery is completed only after a matching remote GET', async () => {
  const result = await runDemo();
  assert.equal(result.taskState, 'completed');
  assert.equal(result.jobState, 'completed');
  assert.equal(result.operationState, 'confirmed');
  assert.equal(result.completionBasis, 'local_file_checked');
  assert.equal(result.putCount, 1);
  assert.equal(result.attempts, 1);
});

test('a mismatched remote GET leaves the effect uncertain and blocks completion', async () => {
  const result = await runDemo({mismatch: true});
  assert.equal(result.taskState, 'blocked');
  assert.equal(result.jobState, 'failed');
  assert.equal(result.operationState, 'uncertain');
  assert.equal(result.putCount, 1);
});
