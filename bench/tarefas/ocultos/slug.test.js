import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { slugify } = await load('slug.js');

test('acentos e e-comercial', () => assert.equal(slugify('Ação & Reação!'), 'acao-e-reacao'));
test('espacos e virgula', () => assert.equal(slugify('  Olá,   Mundo  '), 'ola-mundo'));
test('simbolos', () => assert.equal(slugify('C# e .NET 10'), 'c-e-net-10'));
test('trema e til', () => assert.equal(slugify('Über São Paulo'), 'uber-sao-paulo'));
test('cedilha maiuscula', () => assert.equal(slugify('ÇÃO'), 'cao'));
test('vazio e so separadores', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('---'), '');
  assert.equal(slugify('!!!'), '');
});
test('ate 60 caracteres', () => {
  const s = slugify('palavra '.repeat(20));
  assert.ok(s.length <= 60, s);
  assert.ok(!s.endsWith('-'), s);
  assert.ok(s.startsWith('palavra-palavra'), s);
});
test('corte sem hifen no fim', () => assert.equal(slugify('a'.repeat(59) + ' bbbb'), 'a'.repeat(59)));
test('ja e slug', () => assert.equal(slugify('ja-e-slug-123'), 'ja-e-slug-123'));
