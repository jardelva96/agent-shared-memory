/**
 * Reads a shell command (bash or PowerShell) the way the guard needs it: which folders it works in
 * and which git commands in it change a checkout that another session may be using.
 */
import os from 'node:os';
import path from 'node:path';

/** `branch` moves HEAD or rewrites the working tree; `sweep` puts every change into a commit. */
export type GitRisk = 'branch' | 'sweep';

export interface GitStep {
  /** The folder git runs in, after `cd` and `-C`. */
  dir: string;
  subcommand: string;
  args: string[];
  risk?: GitRisk;
  /** The git command as written, for messages. */
  text: string;
}

export interface ParsedShell {
  /** Every folder the command works in: the start folder and each `cd` / `-C` target. */
  dirs: string[];
  git: GitStep[];
  /** Set when the command ends with `# asm-ok`; the text after it is the reason. */
  acknowledged?: string;
}

const ACK = /#\s*asm-ok\b:?[ \t]*([^\r\n]*)/i;
const CD = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup', 'env', '&']);
const GIT_FLAGS_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

export function parseShell(command: string, cwd: string): ParsedShell {
  const ack = ACK.exec(command);
  const dirs = [path.resolve(cwd)];
  const git: GitStep[] = [];
  let here = path.resolve(cwd);

  for (const segment of segments(withoutHeredocs(command))) {
    const tokens = withoutPrefixes(words(segment));
    if (!tokens.length) continue;
    const head = tokens[0].replace(/^\(+/, '');
    const name = path.basename(head).toLowerCase().replace(/\.exe$/, '');

    if (CD.has(name)) {
      const target = tokens.slice(1).find((t, i, all) => !t.startsWith('-') || (i > 0 && /^-(path|literalpath)$/i.test(all[i - 1])));
      const next = target && !/^-(path|literalpath)$/i.test(target) ? target : undefined;
      const resolved = next ? resolveDir(here, next) : undefined;
      if (resolved) {
        here = resolved;
        dirs.push(here);
      }
      continue;
    }

    if (name === 'git') {
      const step = readGit(tokens.slice(1), here);
      if (step) {
        if (step.dir !== here) dirs.push(step.dir);
        git.push({ ...step, text: segment.trim().replace(/\s+/g, ' ').slice(0, 200) });
      }
    }
  }

  return { dirs: [...new Set(dirs)], git, ...(ack ? { acknowledged: ack[1].trim() } : {}) };
}

/**
 * What a command runs, without its arguments ("cd && git checkout && dotnet"): enough for another
 * session to recognise who it is, and never a password or token that was on the command line.
 */
export function summarize(command: string): string {
  const heads: string[] = [];
  for (const segment of segments(withoutHeredocs(command))) {
    const tokens = withoutPrefixes(words(segment));
    if (!tokens.length) continue;
    const name = path.basename(tokens[0].replace(/^\(+/, '')).toLowerCase().replace(/\.exe$/, '');
    if (!/^[a-z0-9._-]+$/.test(name)) continue;
    heads.push(name === 'git' ? `git ${readGit(tokens.slice(1), '.')?.subcommand ?? ''}`.trim() : name);
  }
  const text = heads.join(' && ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** Drops what runs a command without being it: `X=1`, `sudo`, `nohup`, `timeout 300`, an opening `(`. */
function withoutPrefixes(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length) {
    const first = out[0].toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]) || PREFIXES.has(first) || first === '(' || first === '{') {
      out.shift();
      continue;
    }
    if (first === 'timeout') {
      out.shift();
      while (out.length && (out[0].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(out[0]))) out.shift();
      continue;
    }
    break;
  }
  return out;
}

function readGit(argv: string[], start: string): Omit<GitStep, 'text'> | undefined {
  let dir = start;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C') {
      const next = argv[++i];
      const resolved = next ? resolveDir(dir, next) : undefined;
      if (resolved) dir = resolved;
      continue;
    }
    if (GIT_FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    break;
  }
  const subcommand = argv[i]?.toLowerCase();
  if (!subcommand) return undefined;
  const args = argv.slice(i + 1).filter(a => !a.startsWith('#'));
  return { dir, subcommand, args, risk: classifyGit(subcommand, args) };
}

/** Short flags written together (`-am`) count each letter. */
function hasShort(args: string[], letter: string): boolean {
  return args.some(a => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

export function classifyGit(subcommand: string, args: string[]): GitRisk | undefined {
  if (args.includes('-h') || args.includes('--help')) return undefined;
  switch (subcommand) {
    case 'checkout':
    case 'switch':
      return args.length ? 'branch' : undefined;
    case 'stash': {
      const action = args.find(a => !a.startsWith('-'));
      return action && ['list', 'show', 'create', 'store'].includes(action) ? undefined : 'branch';
    }
    case 'reset':
    case 'restore':
    case 'rebase':
    case 'merge':
    case 'pull':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return 'branch';
    case 'clean':
      return args.includes('--dry-run') || hasShort(args, 'n') ? undefined : 'branch';
    case 'commit':
      return args.includes('--all') || hasShort(args, 'a') ? 'sweep' : undefined;
    case 'add':
      return args.some(a => ['.', '-A', '--all', '-u', '--update', ':/', '*', '--no-ignore-removal'].includes(a)) ||
        hasShort(args, 'A') || hasShort(args, 'u')
        ? 'sweep'
        : undefined;
    default:
      return undefined;
  }
}

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'find', 'wc', 'echo', 'printf', 'pwd', 'which', 'type', 'file', 'stat',
  'du', 'df', 'date', 'sort', 'uniq', 'cut', 'tr', 'jq', 'less', 'more', 'tree', 'test', '[', 'true', 'false', 'basename',
  'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'md5sum', 'sha256sum', 'whoami', 'hostname', 'uname', 'printenv',
  'cd', 'pushd', 'popd', 'sleep', 'get-childitem', 'get-content', 'select-string', 'test-path', 'get-item',
  'get-location', 'write-output', 'write-host', 'measure-object', 'dir', 'set-location', 'sl', 'gci', 'gc', 'cygpath'
]);
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'fetch', 'rev-parse', 'reflog', 'ls-files', 'blame', 'grep', 'describe', 'shortlog',
  'merge-base', 'cat-file', 'ls-tree', 'rev-list', 'remote', 'branch', 'tag', 'config', 'stash', 'worktree', 'help', 'version'
]);

/**
 * True when no part of the command can change a file: only reading commands and no redirection to a
 * file. Used to skip the after-command scan, so it must answer false whenever in doubt.
 */
export function isReadOnly(command: string): boolean {
  const body = withoutHeredocs(command);
  if (body !== command) return false;
  const unquoted = body.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  if (/(^|[^0-9&<>=-])\d?>>?\s*(?!\s*(\/dev\/null|&\d|\$null|nul\b))[^\s>&]/i.test(unquoted)) return false;
  for (const segment of segments(body)) {
    const tokens = words(segment);
    if (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
    if (!tokens.length) continue;
    const name = path.basename(tokens[0].replace(/^\(+/, '')).toLowerCase().replace(/\.exe$/, '');
    if (name === 'sed') {
      if (tokens.some(t => t === '-i' || t.startsWith('-i') || t === '--in-place')) return false;
      continue;
    }
    if (name === 'git') {
      const step = readGit(tokens.slice(1), '.');
      if (!step || !GIT_READ_ONLY.has(step.subcommand)) return false;
      if (step.subcommand === 'stash') {
        const action = step.args.find(a => !a.startsWith('-'));
        if (!action || !['list', 'show'].includes(action)) return false;
      }
      if (step.subcommand === 'branch' && step.args.some(a => /^-(d|D|m|M|f|c|C)$/.test(a) || a.startsWith('--delete') || a.startsWith('--move'))) return false;
      continue;
    }
    if (!READ_ONLY.has(name)) return false;
  }
  return true;
}

/** Bash heredocs and PowerShell here-strings are text, not commands: their lines are dropped. */
function withoutHeredocs(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let until: RegExp | undefined;
  for (const line of lines) {
    if (until) {
      if (until.test(line)) until = undefined;
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (heredoc) until = new RegExp(`^\\s*${heredoc[2]}\\s*$`);
    else if (/@['"]\s*$/.test(line)) until = /^['"]@/;
  }
  return kept.join('\n');
}

/** Splits on && || ; | & and new lines, outside quotes. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      current += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]))) {
      // A comment runs to the end of the line.
      while (i < command.length && command[i] !== '\n') i++;
      out.push(current);
      current = '';
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
        current += c;
        continue;
      }
      out.push(current);
      current = '';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map(s => s.trim()).filter(Boolean);
}

/** Words of one segment, quotes removed. Backslashes are kept: on Windows they are path separators. */
function words(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = undefined;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += c;
  }
  if (started || current) out.push(current);
  return out;
}

/** A folder as the shell would reach it. Variables and `-` cannot be resolved here, so they are skipped. */
function resolveDir(from: string, target: string): string | undefined {
  if (!target || target === '-' || /[$`%]/.test(target)) return undefined;
  let t = target;
  if (t === '~' || t.startsWith('~/')) t = path.join(os.homedir(), t.slice(1));
  // Git Bash on Windows writes C:\x as /c/x.
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(t);
  if (msys && process.platform === 'win32') t = `${msys[1].toUpperCase()}:${msys[2] ?? '/'}`;
  return path.resolve(from, t);
}
