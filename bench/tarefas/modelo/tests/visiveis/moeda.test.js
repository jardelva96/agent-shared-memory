import test from 'node:test';
import assert from 'node:assert/strict';
import { formatarBRL } from '../../src/moeda.js';
test('exemplos', () => {
  assert.equal(formatarBRL(1234.5), 'R$ 1.234,50');
  assert.equal(formatarBRL(0), 'R$ 0,00');
  assert.equal(formatarBRL(-7), '-R$ 7,00');
});
