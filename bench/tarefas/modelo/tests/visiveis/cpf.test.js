import test from 'node:test';
import assert from 'node:assert/strict';
import { validarCPF } from '../../src/cpf.js';
test('exemplos', () => {
  assert.equal(validarCPF('529.982.247-25'), true);
  assert.equal(validarCPF('52998224725'), true);
  assert.equal(validarCPF('111.111.111-11'), false);
});
