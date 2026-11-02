import { randomUUID } from 'node:crypto';

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function createSessionId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
}

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

/** Agent ids are used verbatim as file names, so they are validated rather than sanitised. */
export function assertAgentId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error('Agent id must not be empty.');
  if (!SAFE_ID.test(id) || !/[a-zA-Z0-9]/.test(id)) {
    throw new Error(
      `Invalid agent id: ${JSON.stringify(value)}. Use letters, digits, dot, dash or underscore, ` +
        'with at least one letter or digit. Ids become file names, so separators are not allowed.'
    );
  }
  return id;
}

/** Short, sortable, readable ids for queue objects. */
function shortId(prefix: string): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase();
  return `${prefix}-${stamp}${rand}`;
}

export function createTaskId(): string {
  return shortId('T');
}

export function createScheduleId(): string {
  return shortId('S');
}
