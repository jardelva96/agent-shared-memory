export function nowIso(): string {
  return new Date().toISOString();
}

export function ageSeconds(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
}

export function localTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-GB', { hour12: false });
}
