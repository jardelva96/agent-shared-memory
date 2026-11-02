import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { formatarBRL } = await load('moeda.js');

test('milhar e centavos', () => assert.equal(formatarBRL(1234.56), 'R$ 1.234,56'));
test('milhoes', () => assert.equal(formatarBRL(1234567.891), 'R$ 1.234.567,89'));
test('espaco comum, nao nbsp', () => assert.equal(formatarBRL(5).charCodeAt(2), 32));
test('zero', () => assert.equal(formatarBRL(0), 'R$ 0,00'));
test('menos zero e quase zero sem sinal', () => {
  assert.equal(formatarBRL(-0), 'R$ 0,00');
  assert.equal(formatarBRL(-0.004), 'R$ 0,00');
  assert.equal(formatarBRL(0.001), 'R$ 0,00');
});
test('negativo', () => assert.equal(formatarBRL(-1234.5), '-R$ 1.234,50'));
test('metade para longe do zero', () => {
  assert.equal(formatarBRL(0.125), 'R$ 0,13');
  assert.equal(formatarBRL(-0.125), '-R$ 0,13');
  assert.equal(formatarBRL(2.5), 'R$ 2,50');
});
test('abaixo de mil sem ponto', () => assert.equal(formatarBRL(999.99), 'R$ 999,99'));
test('exatamente mil', () => assert.equal(formatarBRL(1000), 'R$ 1.000,00'));
test('nao finito lanca TypeError', () => {
  assert.throws(() => formatarBRL(NaN), TypeError);
  assert.throws(() => formatarBRL(Infinity), TypeError);
  assert.throws(() => formatarBRL('10'), TypeError);
});
