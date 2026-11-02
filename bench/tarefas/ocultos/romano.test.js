import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { paraRomano, deRomano } = await load('romano.js');

test('1994', () => assert.equal(paraRomano(1994), 'MCMXCIV'));
test('limites', () => {
  assert.equal(paraRomano(1), 'I');
  assert.equal(paraRomano(3999), 'MMMCMXCIX');
});
test('subtracoes', () => {
  assert.equal(paraRomano(4), 'IV');
  assert.equal(paraRomano(9), 'IX');
  assert.equal(paraRomano(40), 'XL');
  assert.equal(paraRomano(90), 'XC');
  assert.equal(paraRomano(400), 'CD');
  assert.equal(paraRomano(900), 'CM');
});
test('fora da faixa', () => {
  assert.throws(() => paraRomano(0), RangeError);
  assert.throws(() => paraRomano(4000), RangeError);
  assert.throws(() => paraRomano(2.5), RangeError);
  assert.throws(() => paraRomano(-1), RangeError);
});
test('ida e volta 1..3999', () => {
  for (let n = 1; n <= 3999; n++) assert.equal(deRomano(paraRomano(n)), n);
});
test('de romano', () => {
  assert.equal(deRomano('MCMXCIV'), 1994);
  assert.equal(deRomano('XLII'), 42);
});
test('nao canonico', () => {
  for (const s of ['IIII', 'IC', 'VV', 'XM', 'IIV']) assert.throws(() => deRomano(s), RangeError, s);
});
test('minuscula e vazio', () => {
  assert.throws(() => deRomano('mcm'), RangeError);
  assert.throws(() => deRomano(''), RangeError);
  assert.throws(() => deRomano('ABC'), RangeError);
});
