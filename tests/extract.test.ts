import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractSymbol } from '../src/core/extract.js';

test('a function comes back whole, with its doc comment', () => {
  const source = [
    'const before = 1;',
    '',
    '/** Adds two numbers. */',
    'export function soma(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'const after = 2;'
  ].join('\n');

  const found = extractSymbol(source, 'soma')!;
  assert.match(found.text, /Adds two numbers/, 'the comment explains the symbol, so it comes too');
  assert.match(found.text, /return a \+ b;/);
  assert.doesNotMatch(found.text, /const after/, 'and stops at the closing brace');
  assert.equal(found.startLine, 3);
  assert.equal(found.endLine, 6);
});

test('a call is not mistaken for the declaration', () => {
  const source = [
    'function caller() {',
    '  return soma(1, 2);',
    '}',
    '',
    'export function soma(a, b) {',
    '  return a + b;',
    '}'
  ].join('\n');

  const found = extractSymbol(source, 'soma')!;
  assert.match(found.text, /export function soma/);
  assert.doesNotMatch(found.text, /function caller/);
});

test('a brace inside a string or comment does not end the block early', () => {
  const source = [
    'export function render() {',
    '  const template = "} not the end {";',
    '  /* } neither is this */',
    '  return template;',
    '}',
    'const after = 1;'
  ].join('\n');

  const found = extractSymbol(source, 'render')!;
  assert.match(found.text, /return template;/, 'the body survived the decoys');
  assert.doesNotMatch(found.text, /const after/);
});

test('an interface and a class are found the same way', () => {
  const source = [
    'export interface ProjectConfig {',
    '  staleAfterSeconds: number;',
    '  maxReviewRounds: number;',
    '}',
    '',
    'export class TaskStore {',
    '  read() {}',
    '}'
  ].join('\n');

  assert.match(extractSymbol(source, 'ProjectConfig')!.text, /maxReviewRounds/);
  const store = extractSymbol(source, 'TaskStore')!;
  assert.match(store.text, /read\(\) \{\}/);
  assert.doesNotMatch(store.text, /staleAfterSeconds/);
});

test('a qualified pointer finds the bare method in the file', () => {
  // Pointers are written both ways depending on who wrote them; the file has one spelling.
  const source = ['class OrderService {', '  async CancelAsync(id) {', '    return id;', '  }', '}'].join('\n');
  const found = extractSymbol(source, 'OrderService.CancelAsync(Guid id)')!;
  assert.match(found.text, /CancelAsync\(id\)/);
  assert.doesNotMatch(found.text, /class OrderService/, 'the method, not its whole class');
});

test('an indented Python def stops where the indentation returns', () => {
  const source = [
    'def outer():',
    '    pass',
    '',
    'def media(valores):',
    '    total = sum(valores)',
    '',
    '    return total / len(valores)',
    '',
    'def depois():',
    '    pass'
  ].join('\n');

  const found = extractSymbol(source, 'media')!;
  assert.match(found.text, /return total \/ len\(valores\)/, 'a blank line inside the body is not the end');
  assert.doesNotMatch(found.text, /def depois/);
  assert.doesNotMatch(found.text, /def outer/);
});

test('a one-line constant does not swallow the rest of the file', () => {
  const source = ['const LOCK_WAIT_MS = 15_000;', 'const OTHER = 1;', 'function f() {}'].join('\n');
  const found = extractSymbol(source, 'LOCK_WAIT_MS')!;
  assert.equal(found.text.trim(), 'const LOCK_WAIT_MS = 15_000;');
});

test('an unknown symbol returns nothing rather than a confident wrong slice', () => {
  const source = 'export function soma(a, b) { return a + b; }';
  assert.equal(extractSymbol(source, 'naoExiste'), undefined);
  assert.equal(extractSymbol(source, ''), undefined);
  // A word that only appears inside another identifier must not match.
  assert.equal(extractSymbol('const somatorio = 1;', 'soma'), undefined);
});

test('it holds up on this repository, which is what it exists for', async () => {
  const config = await readFile(new URL('../src/core/config.ts', import.meta.url), 'utf8');
  const defaults = extractSymbol(config, 'DEFAULT_CONFIG')!;
  assert.match(defaults.text, /projectName/, 'the field a 7B got wrong from the whole file');
  assert.match(defaults.text, /maxReviewRounds/);
  assert.ok(defaults.endLine - defaults.startLine < 25, 'a slice, not the file');

  const types = await readFile(new URL('../src/models/types.ts', import.meta.url), 'utf8');
  const shape = extractSymbol(types, 'ProjectConfig')!;
  assert.match(shape.text, /maxTaskAttempts/);
  assert.ok(shape.text.split('\n').length < types.split('\n').length / 2, 'much smaller than the file');
});
