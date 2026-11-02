import test from 'node:test';
import assert from 'node:assert/strict';
import { paraRomano, deRomano } from '../../src/romano.js';
test('exemplos', () => {
  assert.equal(paraRomano(1994), 'MCMXCIV');
  assert.equal(deRomano('MCMXCIV'), 1994);
  assert.equal(paraRomano(4), 'IV');
});
