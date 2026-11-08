import test from 'node:test';
import assert from 'node:assert/strict';
import { localTime } from '../src/utils/time.js';

const english = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

/** Every 11th hour of a year, so every hour of the day, plus clock changes and midnight. */
function sampleTimes(): string[] {
  const times: string[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let hour = 0; hour < 366 * 24; hour += 11) {
    times.push(new Date(start + hour * 3600_000 + ((hour * 7) % 60) * 60_000 + ((hour * 13) % 60) * 1000).toISOString());
  }
  times.push('2026-03-29T00:59:59.999Z', '2026-03-29T01:00:00.000Z', '2026-10-25T00:59:59.000Z', '2026-10-25T01:00:00.000Z');
  times.push('2026-11-01T02:59:59.000Z', '2026-11-01T03:00:00.000Z', '2026-11-08T23:59:59.000Z', '2026-11-09T00:00:00.000Z');
  return times;
}

test('localTime writes the same text as the en-GB locale, in every time zone tried', () => {
  const zone = process.env.TZ;
  const midnights = new Set<string>();
  try {
    for (const tz of [zone, 'UTC', 'America/Sao_Paulo', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide']) {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      midnights.add(localTime('2026-01-01T00:00:00.000Z'));
      for (const iso of sampleTimes()) assert.equal(localTime(iso), english(iso), `${iso} in ${tz ?? 'the system zone'}`);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.ok(midnights.size > 3, 'the zones really changed');
  assert.equal(localTime('not a date'), english('not a date'));
});

test('localTime does not load locale data, which costs a hook call 6 to 13 ms the first time', () => {
  const original = Date.prototype.toLocaleTimeString;
  let calls = 0;
  Date.prototype.toLocaleTimeString = function (...args: Parameters<Date['toLocaleTimeString']>) {
    calls++;
    return original.apply(this, args);
  };
  try {
    localTime('2026-11-08T12:34:56.000Z');
  } finally {
    Date.prototype.toLocaleTimeString = original;
  }
  assert.equal(calls, 0);
});
