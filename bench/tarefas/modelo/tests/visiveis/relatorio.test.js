import test from 'node:test';
import assert from 'node:assert/strict';
import { resumoDePedidos } from '../../src/relatorio.js';
test('exemplo', () => {
  assert.deepEqual(resumoDePedidos([{ status: 'pago', valor: 10 }, { status: 'cancelado', valor: 5 }]),
    { pago: 'R$ 10,00', pendente: 'R$ 0,00', cancelado: 'R$ 5,00', total: 'R$ 10,00' });
});
