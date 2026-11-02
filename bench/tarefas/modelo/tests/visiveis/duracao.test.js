import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuracao } from '../../src/duracao.js';
test('exemplos', () => {
  assert.equal(parseDuracao('1h30m'), 5400);
  assert.equal(parseDuracao('45s'), 45);
  assert.equal(parseDuracao('1h 5m 10s'), 3910);
});
