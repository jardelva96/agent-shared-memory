/**
 * File reservations: an agent claims a file, a folder or a glob before changing it, for a
 * limited time, and the others are refused while the claim holds.
 *
 * A notice ("someone else is on this file") was measured not to be enough on its own: an
 * agent that had read the file earlier still wrote over a newer version. A reservation is
 * checked where writes happen -- the pre-write hook, the git pre-commit hook -- so it holds
 * without the model having to remember it.
 *
 * Every reservation expires. An agent that crashes while holding one blocks nobody for
 * longer than its lease, the same rule the task queue uses for claims.
 */
import path from 'node:path';
import { FileReservation } from '../models/types.js';
import { atomicWriteJson, readJson, withFileLock } from '../utils/fs.js';
import { createId } from '../utils/ids.js';
import { resolvePaths } from './paths.js';

export interface ReservationConflict {
  pattern: string;
  holder: FileReservation;
}

export interface ReserveResult {
  granted: FileReservation[];
  /** When not empty, nothing was granted: a reservation is all of its paths or none. */
  conflicts: ReservationConflict[];
}

export interface ReserveOptions {
  exclusive?: boolean;
  ttlSeconds?: number;
  reason?: string;
  now?: Date;
}

export const DEFAULT_RESERVATION_SECONDS = 1800;

/** `src/a.ts`, `./src/a.ts` and `src\a.ts` are one path; anything escaping the root is refused. */
export function normalizePattern(pattern: string): string {
  const cleaned = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || cleaned.split('/').includes('..')) {
    throw new Error(`Not a project path: ${JSON.stringify(pattern)}. Use a path relative to the project root.`);
  }
  // A folder written with its slash means everything inside it.
  return cleaned.endsWith('/') ? `${cleaned}**` : cleaned;
}

const WILD = /[*?]/;

export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Whether a path is covered by a reservation pattern. A plain folder path covers its contents. */
export function patternCovers(pattern: string, file: string): boolean {
  if (WILD.test(pattern)) return globToRegExp(pattern).test(file);
  const a = pattern.toLowerCase();
  const b = file.toLowerCase();
  return a === b || b.startsWith(`${a}/`);
}

/**
 * Whether two patterns can name a common file. Conservative for two globs: they overlap
 * when one's fixed prefix contains the other's, which may refuse a pair that never meets,
 * but never lets two exclusive claims cover the same file.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const wildA = WILD.test(a);
  const wildB = WILD.test(b);
  if (!wildA && !wildB) return patternCovers(a, b) || patternCovers(b, a);
  if (!wildA) return patternCovers(b, a) || staticPrefix(b).startsWith(a.toLowerCase());
  if (!wildB) return patternCovers(a, b) || staticPrefix(a).startsWith(b.toLowerCase());
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function staticPrefix(pattern: string): string {
  const cut = pattern.search(WILD);
  return (cut < 0 ? pattern : pattern.slice(0, cut)).toLowerCase();
}

export class ReservationStore {
  constructor(public readonly root = process.cwd()) {}

  private get file(): string {
    return path.join(resolvePaths(this.root).agentsDir, 'reservations.json');
  }

  private get lock(): string {
    return path.join(resolvePaths(this.root).locksDir, 'reservations.lock');
  }

  private async load(): Promise<FileReservation[]> {
    try {
      const data = await readJson<{ reservations?: FileReservation[] }>(this.file);
      return Array.isArray(data.reservations) ? data.reservations : [];
    } catch {
      return [];
    }
  }

  private async save(list: FileReservation[]): Promise<void> {
    await atomicWriteJson(this.file, { reservations: list });
  }

  /** Reservations still in force. Expired ones are ignored here and dropped on the next write. */
  async active(now = new Date()): Promise<FileReservation[]> {
    return (await this.load()).filter(r => Date.parse(r.expiresAt) > now.getTime());
  }

  /** Who holds `file`, other than `exceptAgent`. */
  async holders(file: string, exceptAgent?: string, now = new Date()): Promise<FileReservation[]> {
    const target = normalizePattern(file);
    return (await this.active(now)).filter(r => r.agentId !== exceptAgent && patternCovers(r.pattern, target));
  }

  async reserve(agentId: string, patterns: string[], options: ReserveOptions = {}): Promise<ReserveResult> {
    const exclusive = options.exclusive !== false;
    const ttl = Math.max(30, Math.min(options.ttlSeconds ?? DEFAULT_RESERVATION_SECONDS, 24 * 3600));
    const wanted = [...new Set(patterns.map(normalizePattern))];
    if (wanted.length === 0) throw new Error('Name at least one path to reserve.');

    return withFileLock(this.lock, async () => {
      const now = options.now ?? new Date();
      const live = (await this.load()).filter(r => Date.parse(r.expiresAt) > now.getTime());

      // Exclusive conflicts with any other holder; shared only with another's exclusive.
      const conflicts: ReservationConflict[] = [];
      for (const pattern of wanted) {
        for (const other of live) {
          if (other.agentId === agentId || !patternsOverlap(pattern, other.pattern)) continue;
          if (exclusive || other.exclusive) conflicts.push({ pattern, holder: other });
        }
      }
      if (conflicts.length > 0) return { granted: [], conflicts };

      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
      const granted: FileReservation[] = [];
      const kept = live.filter(r => !(r.agentId === agentId && wanted.includes(r.pattern)));
      for (const pattern of wanted) {
        // Reserving again what you already hold renews it rather than stacking a second one.
        const previous = live.find(r => r.agentId === agentId && r.pattern === pattern);
        const reservation: FileReservation = {
          id: previous?.id ?? createId('R'),
          agentId,
          pattern,
          exclusive,
          reason: options.reason ?? previous?.reason,
          createdAt: previous?.createdAt ?? createdAt,
          expiresAt
        };
        kept.push(reservation);
        granted.push(reservation);
      }
      await this.save(kept);
      return { granted, conflicts: [] };
    });
  }

  /** Releases the agent's reservations on these patterns, or all of them. Returns how many. */
  async release(agentId: string, patterns?: string[]): Promise<number> {
    const which = patterns?.length ? new Set(patterns.map(normalizePattern)) : undefined;
    return withFileLock(this.lock, async () => {
      const now = Date.now();
      const all = (await this.load()).filter(r => Date.parse(r.expiresAt) > now);
      const kept = all.filter(r => r.agentId !== agentId || (which !== undefined && !which.has(r.pattern)));
      await this.save(kept);
      return all.length - kept.length;
    });
  }

  /** Extends every reservation the agent holds. Returns how many. */
  async renew(agentId: string, ttlSeconds = DEFAULT_RESERVATION_SECONDS): Promise<number> {
    return withFileLock(this.lock, async () => {
      const now = Date.now();
      const all = (await this.load()).filter(r => Date.parse(r.expiresAt) > now);
      let renewed = 0;
      for (const r of all) {
        if (r.agentId !== agentId) continue;
        r.expiresAt = new Date(now + Math.max(30, ttlSeconds) * 1000).toISOString();
        renewed++;
      }
      await this.save(all);
      return renewed;
    });
  }
}
