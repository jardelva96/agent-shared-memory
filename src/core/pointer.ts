import { CodePointer } from '../models/types.js';

export function parsePointer(input?: string): CodePointer | undefined {
  if (!input) return undefined;
  const [filePart, symbolPart, parameterPart] = input.split('::').map(v => v.trim());
  if (!filePart) return undefined;
  return {
    file: normalizeFile(filePart),
    symbol: symbolPart || undefined,
    parameter: parameterPart || undefined
  };
}

export function pointerKey(pointer?: CodePointer): string {
  if (!pointer) return '';
  return [fileKey(pointer.file), normalize(pointer.symbol), normalize(pointer.parameter)]
    .filter(Boolean)
    .join('::');
}

export function formatPointer(pointer?: CodePointer): string {
  if (!pointer) return '-';
  const parts = [pointer.file];
  if (pointer.symbol) parts.push(pointer.symbol);
  if (pointer.parameter) parts.push(`parameter=${pointer.parameter}`);
  return parts.join(' -> ');
}

export function pointersOverlap(a?: CodePointer, b?: CodePointer): { overlap: boolean; exact: boolean } {
  if (!a || !b) return { overlap: false, exact: false };
  const fileA = fileKey(a.file);
  const fileB = fileKey(b.file);
  if (fileA !== fileB) return { overlap: false, exact: false };

  const symbolA = canonicalSymbol(a.symbol);
  const symbolB = canonicalSymbol(b.symbol);
  const parameterA = normalize(a.parameter);
  const parameterB = normalize(b.parameter);

  if (!symbolA || !symbolB) {
    return { overlap: true, exact: pointerKey(a) === pointerKey(b) };
  }

  if (!symbolsMatch(symbolA, symbolB)) return { overlap: false, exact: false };
  if (parameterA && parameterB && parameterA !== parameterB) {
    return { overlap: true, exact: false };
  }

  return { overlap: true, exact: pointerKey(a) === pointerKey(b) };
}

function normalize(value?: string): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Reduces a symbol to what identifies it, dropping how the writer spelled the call.
 *
 * Two agents describing the same function wrote `parseArgs()` and `parseArgs(argv)`, and
 * comparing those as strings said they were unrelated — the tool stayed silent on exactly
 * the collision it exists to report. Parameter names and types are the writer's choice,
 * so they are removed; an explicit `parameter` on the pointer still narrows the match.
 */
function canonicalSymbol(value?: string): string {
  const normalized = normalize(value);
  if (!normalized) return '';

  // Everything from the first parenthesis on is the argument list. Cutting there rather
  // than matching a balanced group handles a nested call like `f(g(x))`, which a
  // non-greedy paren match mangled into `f)`.
  const open = normalized.indexOf('(');
  const head = (open >= 0 ? normalized.slice(0, open) : normalized).replace(/\s+/g, '').replace(/[;,]+$/, '');

  // A symbol that is only an argument list would canonicalize to nothing, and an empty
  // symbol means "anywhere in this file" — so it would collide with every pointer there.
  // Fall back to the written form instead of widening the match.
  return head || normalized.replace(/\s+/g, '');
}

/**
 * Qualified and bare forms of the same symbol match: `orderservice.cancelasync` and
 * `cancelasync` are the same method, since both pointers already name the same file.
 */
function symbolsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Case is folded only where the filesystem folds it.
 *
 * On Windows and macOS `src/Cli/args.ts` and `src/cli/args.ts` are one file, so treating
 * them as different hides a real clash. On Linux they are genuinely two files, and
 * folding there would invent a collision that cannot happen.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** The stored form: separators and `./` only, so the path is shown as it was written. */
function normalizeFile(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * The comparison form. Kept separate from the stored form on purpose: folding at storage
 * time would rewrite what the agent typed, and break every comparison against a source
 * that does not fold — the git watcher matches pointers against real paths from git.
 */
function fileKey(value: string): string {
  const cleaned = normalizeFile(value);
  return CASE_INSENSITIVE_FS ? cleaned.toLowerCase() : cleaned;
}
