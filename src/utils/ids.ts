import { randomUUID } from 'node:crypto';

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function createSessionId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
}

/** Agent ids reach the filesystem as file names, so they must not carry path separators. */
export function safeName(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!safe) throw new Error('Invalid agent id');
  return safe;
}
