export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that never take a value. Without this list a boolean flag placed before the
 * command would swallow it: `--json status` would parse as json="status" and leave no
 * command at all.
 */
const BOOLEAN_FLAGS = new Set([
  'json',
  'force',
  'history',
  'dry-run',
  'once',
  'all',
  'peek',
  'help'
]);

/**
 * The command is the first bare word, wherever it appears, so global flags work on either
 * side of it: `agent-memory --root X status` and `agent-memory status --root X` are the
 * same. Flag values are consumed before the search, so `--root status` does not mistake
 * the path for the command.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  const command = positionals.shift();
  return { command, positionals, flags };
}

export function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(flags: ParsedArgs['flags'], name: string): boolean {
  const value = flags[name];
  if (value === true) return true;
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

export function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}
