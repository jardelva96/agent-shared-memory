import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { resumoDePedidos } = await load('relatorio.js');

const zero = 'R$ 0,00';
test('exemplo', () =>
  assert.deepEqual(resumoDePedidos([{ status: 'pago', valor: 10 }, { status: 'cancelado', valor: 5 }]), {
    pago: 'R$ 10,00',
    pendente: zero,
    cancelado: 'R$ 5,00',
    total: 'R$ 10,00'
  }));
test('vazio', () => assert.deepEqual(resumoDePedidos([]), { pago: zero, pendente: zero, cancelado: zero, total: zero }));
test('centavos sem erro de ponto flutuante', () =>
  assert.equal(resumoDePedidos([{ status: 'pago', valor: 0.1 }, { status: 'pago', valor: 0.2 }]).pago, 'R$ 0,30'));
test('total soma pago e pendente', () =>
  assert.equal(
    resumoDePedidos([{ status: 'pago', valor: 1000 }, { status: 'pendente', valor: 234.56 }, { status: 'cancelado', valor: 99 }]).total,
    'R$ 1.234,56'
  ));
test('status desconhecido', () => assert.throws(() => resumoDePedidos([{ status: 'estornado', valor: 1 }]), Error));
test('usa formatarBRL de moeda.js', () => {
  const src = readFileSync(`${process.env.PROJETO}/src/relatorio.js`, 'utf8');
  assert.match(src, /from\s+['"]\.\/moeda\.js['"]/);
  assert.match(src, /formatarBRL\(/);
});
