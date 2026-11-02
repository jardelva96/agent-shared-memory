import test from 'node:test';
import assert from 'node:assert/strict';
import { contarPalavras } from '../../src/texto.js';
test('exemplos', () => {
  assert.equal(contarPalavras('Ola, mundo!'), 2);
  assert.equal(contarPalavras('guarda-chuva e pao'), 3);
});
