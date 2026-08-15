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
/** Every flag the CLI understands, so a typo fails instead of being ignored. */
const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  'root',
  'agent',
  'role',
  'task',
  'name',
  'stale',
  'recent',
  'auto-compact',
  'keep',
  'limit',
  'message',
  'description',
  'pointer',
  'reason',
  'for',
  'from',
  'to',
  'id',
  'port',
  'interval',
  'status',
  'title',
  'detail',
  'parent',
  'cron',
  'exec',
  'timeout',
  'max-tasks',
  'max-cost',
  'claim-seconds',
  'max-attempts',
  'version'
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }

    // `--flag=value` is accepted so a value starting with "--" can still be passed.
    const equals = item.indexOf('=');
    const key = equals > 2 ? item.slice(2, equals) : item.slice(2);
    const inlineValue = equals > 2 ? item.slice(equals + 1) : undefined;

    if (!KNOWN_FLAGS.has(key)) {
      throw new Error(`Unknown flag: --${key}. Run "agent-memory help" to see the accepted flags.`);
    }

    if (BOOLEAN_FLAGS.has(key)) {
      // An explicit value has to be honoured, in either form. Swallowing it and forcing
      // true meant `compact --history false` rotated every history the user just said not
      // to touch, and `register --force false` reset a live agent.
      const spaced = inlineValue === undefined && isBooleanWord(argv[i + 1]) ? argv[++i] : undefined;
      const value = inlineValue ?? spaced;
      flags[key] = value === undefined ? true : value !== 'false' && value !== '0';
      continue;
    }

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} needs a value. Use --${key}=<value> if the value starts with "--".`);
    }
    flags[key] = next;
    i++;
  }

  const command = positionals.shift();
  return { command, positionals, flags };
}

export function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function isBooleanWord(value: string | undefined): boolean {
  return value === 'true' || value === 'false' || value === '1' || value === '0';
}

export function boolFlag(flags: ParsedArgs['flags'], name: string): boolean {
  const value = flags[name];
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

export function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}
