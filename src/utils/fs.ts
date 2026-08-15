import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A lock older than this is treated as abandoned by a dead process. */
const STALE_LOCK_MS = 30_000;

/**
 * Codes that mean "someone else is touching this right now", not "this is broken".
 *
 * POSIX reports a held lock as EEXIST. Windows also reports EPERM/EACCES/EBUSY when the
 * target is in pending-delete (another process removed it but still holds a handle) or is
 * momentarily open by a reader or a virus scanner. Treating those as fatal kills an agent
 * mid-write under concurrency, which is exactly when it matters most.
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

export class LockTimeoutError extends Error {
  constructor(public readonly lockFile: string, public readonly lastCode: string) {
    super(`Timed out waiting for lock: ${lockFile} (last error ${lastCode})`);
    this.name = 'LockTimeoutError';
  }
}

export function isLockTimeout(error: unknown): error is LockTimeoutError {
  return error instanceof LockTimeoutError;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T> {
  const content = await readFile(file, 'utf8');
  return JSON.parse(content) as T;
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  // The random suffix matters: two writes from one process in the same millisecond
  // would otherwise pick the same temp path and clobber each other.
  const temp = `${file}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    // Never leave the temp file behind to be mistaken for real state.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  await ensureDir(path.dirname(lockFile));
  let lastCode = 'EEXIST';

  while (true) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockFile, 'wx');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!CONTENDED.has(code)) throw error;
      lastCode = code;
      if (await reclaimIfStale(lockFile)) continue;
      if (Date.now() - start >= timeoutMs) throw new LockTimeoutError(lockFile, lastCode);
      await sleep(backoff());
      continue;
    }

    // Acquired. Errors from here on belong to the caller and must not be retried as
    // if they were contention.
    try {
      return await fn();
    } finally {
      await release(handle, lockFile);
    }
  }
}

async function release(handle: Awaited<ReturnType<typeof open>>, lockFile: string): Promise<void> {
  // Releasing must never mask the result of the work that just succeeded.
  try {
    await handle.close();
  } catch {
    // Already closed or the handle is gone.
  }
  try {
    await rm(lockFile, { force: true });
  } catch {
    // Another process may be reclaiming it as stale; the next acquire settles it.
  }
}

async function renameWithRetry(from: string, to: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      // On Windows, renaming over a file a reader currently has open fails with EPERM.
      if (!CONTENDED.has(code) || Date.now() - start >= timeoutMs) throw error;
      await sleep(backoff());
    }
  }
}

/**
 * Removes a lock left behind by a process that died mid-operation.
 * Without this a single crash wedges .agents/ until someone deletes the file by hand.
 */
async function reclaimIfStale(lockFile: string): Promise<boolean> {
  try {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    await rm(lockFile, { force: true });
    return true;
  } catch {
    // Vanished or unreadable: let the next acquire attempt decide.
    return false;
  }
}

/** Jittered so a burst of agents does not retry in lockstep. */
function backoff(): number {
  return 15 + Math.floor(Math.random() * 35);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
