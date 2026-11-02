import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { LRU } = await load('cache.js');

test('descarta o mais antigo', () => {
  const c = new LRU(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});
test('get renova', () => {
  const c = new LRU(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
});
test('set de chave existente renova e nao cresce', () => {
  const c = new LRU(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10);
  assert.equal(c.size, 2);
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 10);
});
test('has nao renova', () => {
  const c = new LRU(2);
  c.set('a', 1);
  c.set('b', 2);
  c.has('a');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
});
test('get de ausente', () => assert.equal(new LRU(1).get('x'), undefined));
test('capacidade 1', () => {
  const c = new LRU(1);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.size, 1);
  assert.equal(c.get('b'), 2);
  assert.equal(c.has('a'), false);
});
test('delete', () => {
  const c = new LRU(2);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size, 0);
});
test('capacidade invalida', () => {
  assert.throws(() => new LRU(0), RangeError);
  assert.throws(() => new LRU(1.5), RangeError);
  assert.throws(() => new LRU('2'), RangeError);
});
test('valor falsy guardado', () => {
  const c = new LRU(2);
  c.set('z', 0);
  assert.equal(c.get('z'), 0);
  assert.equal(c.has('z'), true);
});
