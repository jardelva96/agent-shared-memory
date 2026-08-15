import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePointer, pointersOverlap } from '../src/core/pointer.js';

test('parse semantic pointer', () => {
  const p = parsePointer('src/Orders/OrderService.cs::OrderService.CancelAsync(Guid id)::id');
  assert.deepEqual(p, {
    file: 'src/Orders/OrderService.cs',
    symbol: 'OrderService.CancelAsync(Guid id)',
    parameter: 'id'
  });
});

test('same file and symbol overlap', () => {
  const a = parsePointer('src/A.cs::A.Run()');
  const b = parsePointer('./src/A.cs::A.Run()');
  assert.deepEqual(pointersOverlap(a, b), { overlap: true, exact: true });
});

test('different symbols in same file do not overlap', () => {
  const a = parsePointer('src/A.cs::A.Run()');
  const b = parsePointer('src/A.cs::A.Stop()');
  assert.deepEqual(pointersOverlap(a, b), { overlap: false, exact: false });
});

test('file-only pointer overlaps any symbol in that file', () => {
  const a = parsePointer('src/A.cs');
  const b = parsePointer('src/A.cs::A.Stop()');
  assert.equal(pointersOverlap(a, b).overlap, true);
});
