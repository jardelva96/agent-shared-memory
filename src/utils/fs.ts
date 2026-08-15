import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** A lock older than this is treated as abandoned by a dead process. */
const STALE_LOCK_MS = 30_000;

/** A temp file older than this cannot belong to a write still in flight. */
const STALE_TEMP_MS = 60 * 60_000;

/**
 * Codes that mean "someone else is touching this right now", not "this is broken".
 *
 * POSIX reports a held lock as EEXIST. Windows also reports EPERM/EACCES/EBUSY when the
 * target is in pending-delete (another process removed it but still holds a handle) or is
 * momentarily open by a reader or a virus scanner. Treating those as fatal kills an agent
 * mid-write under concurrency, which is exactly when it matters most.
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * How long a reader keeps retrying a file that is momentarily gone.
 *
 * Much shorter than the contention budget on purpose: a missing file is a legitimate
 * steady state for callers like `readConfig` and `InboxStore.cursor`, so confirming an
 * absence must stay cheap. The window only has to outlast the gap between a rename and
 * the rewrite that follows it.
 */
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
 * The reader half of the race `renameWithRetry` handles for writers.
 *
 * Reading a file while another process renames over it fails on Windows with
 * EPERM/EBUSY, and any platform can report ENOENT when a caller moves a file aside
 * before rewriting it — `MemoryStore.archiveHistory` renames the history to the archive
 * and only then writes the new stub. Neither means the data is gone, so a raw read here
 * turns a microsecond window into a hard error: `TaskStore.list` silently drops an OPEN
 * task for a whole cycle, and `readState`/`TaskStore.read` throw outright.
 */
export async function readWithRetry(file: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (true) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      const budget = code === 'ENOENT' ? Math.min(MISSING_RETRY_MS, timeoutMs) : timeoutMs;
      if (!CONTENDED.has(code) && code !== 'ENOENT') throw error;
      if (Date.now() - start >= budget) throw error;
      await sleep(backoff());
    }
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  // The random suffix matters: two writes from one process in the same millisecond
  // would otherwise pick the same temp path and clobber each other.
  const temp = `${file}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`;
  try {
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      // Durability, not visibility. The rename is atomic for concurrent readers, but
      // without this the directory entry can reach the disk while the bytes are still
      // in the page cache: a crash then leaves a truncated file, every later readJson
      // throws SyntaxError, and MemoryStore.listStates swallows it so the agent
      // disappears from the panel permanently.
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

export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  await ensureDir(path.dirname(lockFile));
  let lastCode = 'EEXIST';

  // Written into the lock and checked before releasing or reclaiming it. Without an
  // identity, `rm(lockFile)` deletes whatever is at that path — including a lock a
  // different process acquired a millisecond after ours was reclaimed as stale.
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
      await sleep(backoff());
      continue;
    }

    // Acquired. Errors from here on belong to the caller and must not be retried as
    // if they were contention.
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
    // Only delete the lock if it is still ours. A long operation can outlive
    // STALE_LOCK_MS, get reclaimed, and another process can already hold the path;
    // deleting it then would hand the same lock to two processes at once.
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

/**
 * Removes a lock left behind by a process that died mid-operation.
 * Without this a single crash wedges .agents/ until someone deletes the file by hand.
 */
async function reclaimIfStale(lockFile: string): Promise<boolean> {
  try {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;

    // Re-read the identity and re-check the age after deciding it is stale: between the
    // stat and the delete, the owner may have released it and someone else acquired the
    // same path. Deleting by path alone would evict a lock that is very much alive.
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
 * Flushes the directory entry itself, so a crash right after a rename cannot leave the
 * new name missing even though its bytes were written.
 *
 * Windows does not allow opening a directory as a file, and there is no equivalent call;
 * the failure is expected there and carries no information, so it is swallowed.
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

/**
 * Removes temp files left by a process killed between the write and the rename.
 *
 * Only files older than an hour are touched: anything newer could belong to a write still
 * in flight in another process, and deleting that would corrupt it. Called from compact
 * rather than from the write path, where an extra readdir per write would not pay off.
 */
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
