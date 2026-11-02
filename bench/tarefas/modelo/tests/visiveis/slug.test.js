import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../../src/slug.js';
test('exemplos', () => {
  assert.equal(slugify('Acao & Reacao!'), 'acao-e-reacao');
  assert.equal(slugify('  Ola,   Mundo  '), 'ola-mundo');
  assert.equal(slugify('C# e .NET 10'), 'c-e-net-10');
});
