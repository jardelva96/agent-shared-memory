import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { quebrarLinhas } = await load('texto.js');

test('exemplo', () => assert.deepEqual(quebrarLinhas('o rato roeu a roupa', 10), ['o rato', 'roeu a', 'roupa']));
test('cabe exato', () => assert.deepEqual(quebrarLinhas('abc def', 7), ['abc def']));
test('espacos multiplos e tabs', () => assert.deepEqual(quebrarLinhas('  um\t dois   tres ', 8), ['um dois', 'tres']));
test('palavra longa cortada', () => assert.deepEqual(quebrarLinhas('abcdefghij', 4), ['abcd', 'efgh', 'ij']));
test('paragrafos', () => assert.deepEqual(quebrarLinhas('um dois\n\ntres', 20), ['um dois', '', 'tres']));
test('quebra simples nao e paragrafo', () => assert.deepEqual(quebrarLinhas('um\ndois', 20), ['um dois']));
test('vazio', () => {
  assert.deepEqual(quebrarLinhas('', 5), []);
  assert.deepEqual(quebrarLinhas('   ', 5), []);
});
test('largura invalida', () => {
  assert.throws(() => quebrarLinhas('a', 0), RangeError);
  assert.throws(() => quebrarLinhas('a', 2.5), RangeError);
});
