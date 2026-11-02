import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';

export interface GitChange {
  /** Repository-relative path, forward slashes. */
  path: string;
  kind: ChangeKind;
  /** Raw two-letter porcelain code, kept for reporting. */
  code: string;
  /** Original path when the file was renamed or copied. */
  from?: string;
  insertions?: number;
  deletions?: number;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Every path that differs from HEAD, including untracked files. */
export async function changedFiles(root: string): Promise<GitChange[]> {
  const porcelain = await git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  const numstat = await readNumstat(root);
  const records = porcelain.split('\0');
  const changes: GitChange[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;

    const code = record.slice(0, 2);
    const filePath = normalize(record.slice(3));
    let from: string | undefined;

    // A rename or copy is followed by its source path as a separate NUL-terminated record.
    if (code[0] === 'R' || code[0] === 'C') {
      from = normalize(records[++i] ?? '');
    }

    const counts = numstat.get(filePath);
    changes.push({
      path: filePath,
      kind: kindOf(code),
      code,
      ...(from ? { from } : {}),
      ...(counts ?? {})
    });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function readNumstat(root: string): Promise<Map<string, { insertions: number; deletions: number }>> {
  const counts = new Map<string, { insertions: number; deletions: number }>();
  let out: string;
  try {
    out = await git(root, ['diff', '--numstat', 'HEAD']);
  } catch {
    // No commits yet, or HEAD is unreadable: the file list is still valid without counts.
    return counts;
  }

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split('\t');
    if (added === '-' || removed === '-') continue; // binary
    const raw = rest.join('\t');
    // Renames render as "old => new"; the destination is what the caller sees.
    const target = raw.includes(' => ') ? raw.slice(raw.indexOf(' => ') + 4) : raw;
    counts.set(normalize(target), { insertions: Number(added), deletions: Number(removed) });
  }
  return counts;
}

function kindOf(code: string): ChangeKind {
  if (code === '??') return 'untracked';
  const flags = code.replace(/ /g, '');
  if (flags.includes('R')) return 'renamed';
  if (flags.includes('C')) return 'copied';
  if (flags.includes('D')) return 'deleted';
  if (flags.includes('A')) return 'added';
  return 'modified';
}

function normalize(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export function describeChange(change: GitChange): string {
  const parts: string[] = [change.kind];
  if (change.from) parts.push(`from ${change.from}`);
  if (change.insertions !== undefined && change.deletions !== undefined) {
    parts.push(`+${change.insertions}/-${change.deletions}`);
  }
  return parts.join(' ');
}
