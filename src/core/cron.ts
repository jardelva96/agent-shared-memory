/**
 * A small 5-field cron evaluator: minute hour day-of-month month day-of-week.
 *
 * Supports `*`, `n`, `a-b`, `a,b,c`, `*` with a step (`*​/n`) and `a-b/n`.
 * Day-of-week accepts 0-7 with both 0 and 7 meaning Sunday.
 */

export interface CronExpression {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Standard cron: when both day fields are restricted, either one matching is enough. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 }
];

export function parseCron(source: string): CronExpression {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron: ${JSON.stringify(source)}. Expected 5 fields: minute hour day-of-month month day-of-week.`
    );
  }

  const sets = parts.map((part, index) => parseField(part, FIELDS[index]));
  const dayOfWeek = new Set([...sets[4]].map(value => (value === 7 ? 0 : value)));

  return {
    source: source.trim(),
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek,
    dayOfMonthRestricted: parts[2] !== '*',
    dayOfWeekRestricted: parts[4] !== '*'
  };
}

function parseField(part: string, field: { name: string; min: number; max: number }): Set<number> {
  const values = new Set<number>();

  for (const chunk of part.split(',')) {
    const [range, stepRaw] = chunk.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step in ${field.name}: ${JSON.stringify(chunk)}`);
    }

    let start: number;
    let end: number;
    if (range === '*') {
      start = field.min;
      end = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      start = a;
      end = b;
    } else {
      start = Number(range);
      end = stepRaw === undefined ? start : field.max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < field.min || end > field.max || start > end) {
      throw new Error(`Invalid ${field.name} value: ${JSON.stringify(chunk)} (allowed ${field.min}-${field.max})`);
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) throw new Error(`Empty ${field.name} field: ${JSON.stringify(part)}`);
  return values;
}

function dayMatches(expression: CronExpression, date: Date): boolean {
  const dom = expression.dayOfMonth.has(date.getDate());
  const dow = expression.dayOfWeek.has(date.getDay());

  // Both restricted: either matching is enough. Otherwise only the restricted one counts.
  if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) return dom || dow;
  if (expression.dayOfMonthRestricted) return dom;
  if (expression.dayOfWeekRestricted) return dow;
  return true;
}

/**
 * The first minute strictly after `from` that the expression matches, in local time.
 * Returns undefined if nothing matches within four years (an impossible date such as
 * February 30th).
 */
export function nextOccurrence(expression: CronExpression, from: Date = new Date()): Date | undefined {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime());
  limit.setFullYear(limit.getFullYear() + 4);

  while (cursor <= limit) {
    if (!expression.month.has(cursor.getMonth() + 1)) {
      // Jump to the first minute of the next month rather than stepping minute by minute.
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(expression, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!expression.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!expression.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }

  return undefined;
}

export function describeCron(expression: CronExpression): string {
  return expression.source;
}
