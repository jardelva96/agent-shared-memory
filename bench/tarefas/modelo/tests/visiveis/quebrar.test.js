import test from 'node:test';
import assert from 'node:assert/strict';
import { quebrarLinhas } from '../../src/texto.js';
test('exemplo', () => {
  assert.deepEqual(quebrarLinhas('o rato roeu a roupa', 10), ['o rato', 'roeu a', 'roupa']);
});
