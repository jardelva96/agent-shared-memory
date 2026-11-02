import test from 'node:test';
import assert from 'node:assert/strict';
import { LRU } from '../../src/cache.js';
test('exemplo', () => {
  const c = new LRU(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});
