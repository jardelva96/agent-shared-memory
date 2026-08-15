import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A lock older than this is treated as abandoned by a dead process. */
const STALE_LOCK_MS = 30_000;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T> {
  const content = await readFile(file, 'utf8');
  return JSON.parse(content) as T;
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  await ensureDir(path.dirname(lockFile));

  while (true) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockFile, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close();
        await rm(lockFile, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (await reclaimIfStale(lockFile)) continue;
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockFile}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
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
