import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, parseCron } from '../src/core/cron.js';

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string) => nextOccurrence(parseCron(expr), at(from));

test('every minute advances by one minute', () => {
  assert.deepEqual(next('* * * * *', '2026-03-10T08:15:30'), at('2026-03-10T08:16:00'));
});

test('a fixed time picks today or rolls to tomorrow', () => {
  assert.deepEqual(next('30 9 * * *', '2026-03-10T08:00:00'), at('2026-03-10T09:30:00'));
  assert.deepEqual(next('30 9 * * *', '2026-03-10T10:00:00'), at('2026-03-11T09:30:00'));
  // Exactly on the mark returns the next one, never the same minute.
  assert.deepEqual(next('30 9 * * *', '2026-03-10T09:30:00'), at('2026-03-11T09:30:00'));
});

test('steps, lists and ranges are honoured', () => {
  assert.deepEqual(next('*/15 * * * *', '2026-03-10T08:01:00'), at('2026-03-10T08:15:00'));
  assert.deepEqual(next('0 9,17 * * *', '2026-03-10T10:00:00'), at('2026-03-10T17:00:00'));
  assert.deepEqual(next('0 9-11 * * *', '2026-03-10T09:30:00'), at('2026-03-10T10:00:00'));
  assert.deepEqual(next('0 0 1 */6 *', '2026-01-05T00:00:00'), at('2026-07-01T00:00:00'));
});

test('weekday scheduling lands on the right day', () => {
  // 2026-03-10 is a Tuesday; the next Monday 09:00 is the 16th.
  assert.deepEqual(next('0 9 * * 1', '2026-03-10T12:00:00'), at('2026-03-16T09:00:00'));
  // Sunday accepts both 0 and 7.
  assert.deepEqual(next('0 9 * * 0', '2026-03-10T12:00:00'), next('0 9 * * 7', '2026-03-10T12:00:00'));
});

test('when both day fields are restricted, either one matching is enough', () => {
  // Standard cron: day-of-month 1 OR Monday, not both.
  const result = next('0 0 1 * 1', '2026-03-02T12:00:00');
  // 2026-03-09 is the next Monday; 2026-04-01 is the next 1st.
  assert.deepEqual(result, at('2026-03-09T00:00:00'));
});

test('an impossible date yields no occurrence instead of hanging', () => {
  assert.equal(nextOccurrence(parseCron('0 0 30 2 *'), at('2026-01-01T00:00:00')), undefined);
});

test('malformed expressions are rejected with the field named', () => {
  assert.throws(() => parseCron('* * * *'), /Expected 5 fields/);
  assert.throws(() => parseCron('60 * * * *'), /minute/);
  assert.throws(() => parseCron('* 24 * * *'), /hour/);
  assert.throws(() => parseCron('* * 0 * *'), /day-of-month/);
  assert.throws(() => parseCron('* * * 13 *'), /month/);
  assert.throws(() => parseCron('* * * * 8'), /day-of-week/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('5-1 * * * *'), /minute/);
});
