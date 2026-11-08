export function nowIso(): string {
  return new Date().toISOString();
}

export function ageSeconds(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
}

/** HH:MM:SS in local time, as toLocaleTimeString('en-GB') writes it, without loading locale data. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
