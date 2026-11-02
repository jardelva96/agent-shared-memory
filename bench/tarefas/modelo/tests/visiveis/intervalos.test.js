import test from 'node:test';
import assert from 'node:assert/strict';
import { mesclarIntervalos } from '../../src/intervalos.js';
test('exemplos', () => {
  assert.deepEqual(mesclarIntervalos([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
  assert.deepEqual(mesclarIntervalos([[1, 4], [4, 5]]), [[1, 5]]);
});
