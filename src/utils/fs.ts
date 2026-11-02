import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** A lock older than this is treated as abandoned by a dead process. */
const STALE_LOCK_MS = 30_000;

/** A temp file older than this cannot belong to a write still in flight. */
const STALE_TEMP_MS = 60 * 60_000;

/** Codes that mean "someone else is touching this right now", not "this is broken". */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/** How long a reader keeps retrying a file that is momentarily gone. */
const MISSING_RETRY_MS = 150;

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
  const content = await readWithRetry(file);
  return JSON.parse(content) as T;
}

/**
 * For files that may never have been written (reservations, facts, a read cursor): a missing
 * file is `undefined` at once. Waiting for it to reappear cost every write 150 ms.
 */
export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readWithRetry(file, 5000, 0)) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The reader half of the race `renameWithRetry` handles for writers. */
export async function readWithRetry(file: string, timeoutMs = 5000, missingMs = MISSING_RETRY_MS): Promise<string> {
  const start = Date.now();
  while (true) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const budget = code === 'ENOENT' ? Math.min(missingMs, timeoutMs) : timeoutMs;
      if (!CONTENDED.has(code) && code !== 'ENOENT') throw error;
      if (Date.now() - start >= budget) throw error;
      await sleep(backoff());
    }
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  // Random suffix: two writes in the same millisecond must not share a temp path.
  const temp = `${file}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`;
  try {
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      // Durability, not visibility.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    // Never leave the temp file behind to be mistaken for real state.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDir(dir);
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Long enough to outlast a slow-but-alive holder, and still shorter than the window that declares a
 * lock abandoned.
 */
const LOCK_WAIT_MS = 15_000;

/**
 * Runs `fn` under the lock only if it is free right now. `acquired` is false when another process
 * holds it, so a caller with nothing to wait for can leave the work to that process instead.
 */
export async function tryFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  await ensureDir(path.dirname(lockFile));
  const nonce = `${process.pid}.${Date.now()}.${randomSuffix()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockFile, 'wx');
      await handle.writeFile(nonce, 'utf8');
    } catch (error) {
      if (!CONTENDED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (attempt === 0 && (await reclaimIfStale(lockFile))) continue;
      return { acquired: false };
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await release(handle, lockFile, nonce);
    }
  }
  return { acquired: false };
}

export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  timeoutMs = LOCK_WAIT_MS
): Promise<T> {
  const start = Date.now();
  await ensureDir(path.dirname(lockFile));
  let lastCode = 'EEXIST';
  let waits = 0;

  // Written into the lock and checked before releasing or reclaiming it.
  const nonce = `${process.pid}.${Date.now()}.${randomSuffix()}`;

  while (true) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockFile, 'wx');
      await handle.writeFile(nonce, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!CONTENDED.has(code)) throw error;
      lastCode = code;
      if (await reclaimIfStale(lockFile)) continue;
      if (Date.now() - start >= timeoutMs) throw new LockTimeoutError(lockFile, lastCode);
      await sleep(lockBackoff(waits++));
      continue;
    }

    // Acquired.
    try {
      return await fn();
    } finally {
      await release(handle, lockFile, nonce);
    }
  }
}

async function release(
  handle: Awaited<ReturnType<typeof open>>,
  lockFile: string,
  nonce: string
): Promise<void> {
  // Releasing must never mask the result of the work that just succeeded.
  try {
    await handle.close();
  } catch {
    // Already closed or the handle is gone.
  }
  try {
    // Only delete the lock if it is still ours.
    if ((await readFile(lockFile, 'utf8').catch(() => nonce)) === nonce) {
      await rm(lockFile, { force: true });
    }
  } catch {
    // Another process may be reclaiming it; the next acquire settles it.
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

/** Removes a lock left behind by a process that died mid-operation. */
async function reclaimIfStale(lockFile: string): Promise<boolean> {
  try {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;

    // Re-read the identity and re-check the age after deciding it is stale: between the stat and
    // the delete, the owner may have released it and someone else acquired the same path.
    const owner = await readFile(lockFile, 'utf8').catch(() => null);
    const confirm = await stat(lockFile).catch(() => null);
    if (owner === null || confirm === null) return false;
    if (Date.now() - confirm.mtimeMs < STALE_LOCK_MS) return false;

    await rm(lockFile, { force: true });
    return true;
  } catch {
    // Vanished or unreadable: let the next acquire attempt decide.
    return false;
  }
}

/**
 * Flushes the directory entry itself, so a crash right after a rename cannot leave the new name
 * missing even though its bytes were written.
 */
async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Unsupported on this platform, or the directory went away; neither is actionable.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Removes temp files left by a process killed between the write and the rename. */
export async function cleanStaleTemps(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries.filter(name => name.endsWith('.tmp'))) {
    const file = path.join(dir, entry);
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < STALE_TEMP_MS) continue;
      await rm(file, { force: true });
      removed++;
    } catch {
      // Vanished or locked; the next sweep can deal with it.
    }
  }
  return removed;
}

/** Jittered so a burst of agents does not retry in lockstep. */
function backoff(): number {
  return 15 + Math.floor(Math.random() * 35);
}

/**
 * Most locks here guard one append that takes about a millisecond, so the first retries come
 * quickly and the wait doubles from there, up to about 50 ms, jittered like backoff().
 */
function lockBackoff(attempt: number): number {
  const base = Math.min(50, 2 ** attempt);
  return base / 2 + Math.random() * base;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
