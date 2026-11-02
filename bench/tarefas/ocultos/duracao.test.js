import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { parseDuracao } = await load('duracao.js');

test('h e m', () => assert.equal(parseDuracao('1h30m'), 5400));
test('so s', () => assert.equal(parseDuracao('45s'), 45));
test('so h', () => assert.equal(parseDuracao('2h'), 7200));
test('com espacos', () => assert.equal(parseDuracao('1h 5m 10s'), 3910));
test('maior que 59', () => assert.equal(parseDuracao('90m'), 5400));
test('maiuscula e pontas', () => assert.equal(parseDuracao('  1H  '), 3600));
test('vazio', () => {
  assert.equal(parseDuracao(''), null);
  assert.equal(parseDuracao('   '), null);
});
test('sem unidade', () => assert.equal(parseDuracao('10'), null));
test('decimal', () => assert.equal(parseDuracao('1.5h'), null));
test('repetida', () => assert.equal(parseDuracao('1h1h'), null));
test('ordem errada', () => assert.equal(parseDuracao('5m1h'), null));
test('lixo', () => {
  assert.equal(parseDuracao('abc'), null);
  assert.equal(parseDuracao('1h30x'), null);
});
test('nao string', () => {
  assert.equal(parseDuracao(null), null);
  assert.equal(parseDuracao(5400), null);
});
