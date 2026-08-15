import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePointer, pointersOverlap, pointerKey } from '../src/core/pointer.js';

const overlap = (a: string, b: string) => pointersOverlap(parsePointer(a), parsePointer(b));

test('the same function written with and without arguments collides', () => {
  // The false negative the tool existed to prevent: two agents in parseArgs, no warning.
  assert.equal(overlap('src/cli/args.ts::parseArgs()', 'src/cli/args.ts::parseArgs(argv)').overlap, true);
  assert.equal(overlap('src/a.ts::f(a, b)', 'src/a.ts::f(x: number, y: string)').overlap, true);
  assert.equal(overlap('src/a.ts::f', 'src/a.ts::f()').overlap, true);
});

test('a qualified symbol collides with its bare form', () => {
  assert.equal(
    overlap('src/Orders.cs::OrderService.CancelAsync(Guid id)', 'src/Orders.cs::CancelAsync(Guid orderId)').overlap,
    true
  );
});

test('different symbols in the same file still do not collide', () => {
  assert.equal(overlap('src/a.ts::foo()', 'src/a.ts::bar()').overlap, false);
  // A suffix match must be on a segment boundary, not any substring.
  assert.equal(overlap('src/a.ts::doParse()', 'src/a.ts::parse()').overlap, false);
});

test('an explicit parameter still narrows an otherwise equal symbol', () => {
  const result = overlap('src/a.ts::f(x)::alpha', 'src/a.ts::f(y)::beta');
  assert.equal(result.overlap, true);
  assert.equal(result.exact, false, 'different parameters are related, not identical');
});

test('paths are matched the way this filesystem matches them', () => {
  const differentCase = overlap('src/CLI/args.ts::f()', 'src/cli/args.ts::f()');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(differentCase.overlap, true, 'one file here, so it is a real clash');
  } else {
    assert.equal(differentCase.overlap, false, 'two files on Linux; folding would invent a clash');
  }
});

test('separator and prefix spelling never changes the match', () => {
  const backslash = String.fromCharCode(92);
  assert.equal(overlap('./src/a.ts::f()', `src${backslash}a.ts::f()`).overlap, true);
});

test('a file-only pointer still overlaps anything in that file', () => {
  assert.equal(overlap('src/a.ts', 'src/a.ts::whatever()').overlap, true);
});

test('pointerKey stays stable for equal pointers', () => {
  assert.equal(pointerKey(parsePointer('src/a.ts::F()')), pointerKey(parsePointer('src/a.ts::F()')));
});

test('a nested call does not break canonicalisation', () => {
  // A non-greedy paren match turned `f(g(x))` into `f)`, which then matched nothing.
  assert.equal(overlap('src/a.ts::f(g(x))', 'src/a.ts::f(y)').overlap, true);
  assert.equal(overlap('src/a.ts::f(g(x))', 'src/a.ts::h(y)').overlap, false);
});

test('a symbol made only of an argument list does not match everything in the file', () => {
  // Canonicalising this to empty would read as "anywhere in this file".
  assert.equal(overlap('src/a.ts::(x)', 'src/a.ts::realFunction()').overlap, false);
});
