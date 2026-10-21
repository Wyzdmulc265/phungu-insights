import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { zScores, band } from '../src/worker.js';

test('zScores standardizes values (population std)', () => {
  const z = zScores([1, 2, 3]);
  assert.ok(Math.abs(z[0] + 1.2247448713915890) < 1e-9);
  assert.ok(Math.abs(z[1]) < 1e-9);
  assert.ok(Math.abs(z[2] - 1.2247448713915890) < 1e-9);
});

test('zScores preserves nulls and skips them from the mean', () => {
  const z = zScores([1, null, 2, 3]);
  assert.equal(z[1], null);
  // computed over defined values only, same as [1,2,3]
  assert.ok(Math.abs(z[0] + 1.2247448713915890) < 1e-9);
  assert.ok(Math.abs(z[3] - 1.2247448713915890) < 1e-9);
});

test('zScores returns all nulls for fewer than 2 defined values', () => {
  assert.deepEqual(zScores([5]), [null]);
  assert.deepEqual(zScores([null, null]), [null, null]);
});

test('zScores handles constant series (zero std fallback)', () => {
  const z = zScores([5, 5, 5]);
  assert.deepEqual(z, [0, 0, 0]);
});

test('band maps scores to verdict bands', () => {
  assert.equal(band(null), 'NEUTRAL');
  assert.equal(band(0.25), 'BULL');
  assert.equal(band(-0.25), 'BEAR');
  assert.equal(band(0.2499), 'NEUTRAL');
  assert.equal(band(-0.2499), 'NEUTRAL');
  assert.equal(band(0), 'NEUTRAL');
});

test('worker default export exposes a fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function');
});
