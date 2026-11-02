import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const load = file => import(pathToFileURL(`${process.env.PROJETO}/src/${file}`).href);
const { mesclarIntervalos } = await load('intervalos.js');

test('classico', () => assert.deepEqual(mesclarIntervalos([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]));
test('encostados', () => assert.deepEqual(mesclarIntervalos([[1, 4], [4, 5]]), [[1, 5]]));
test('fora de ordem', () => assert.deepEqual(mesclarIntervalos([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]]));
test('aninhado', () => assert.deepEqual(mesclarIntervalos([[1, 10], [2, 3], [4, 5]]), [[1, 10]]));
test('vazio', () => assert.deepEqual(mesclarIntervalos([]), []));
test('negativos', () => assert.deepEqual(mesclarIntervalos([[-5, -1], [-2, 2]]), [[-5, 2]]));
test('nao altera a entrada', () => {
  const a = [[3, 4], [1, 2]];
  const copia = JSON.stringify(a);
  const r = mesclarIntervalos(a);
  assert.equal(JSON.stringify(a), copia);
  assert.notEqual(r, a);
});
test('nao reaproveita o intervalo recebido', () => {
  const um = [1, 2];
  const r = mesclarIntervalos([um]);
  r[0][1] = 99;
  assert.equal(um[1], 2);
});
test('invalido lanca RangeError', () => assert.throws(() => mesclarIntervalos([[5, 2]]), RangeError));
test('ponto', () => assert.deepEqual(mesclarIntervalos([[3, 3], [1, 2]]), [[1, 2], [3, 3]]));
