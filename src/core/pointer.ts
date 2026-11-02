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

/** Reduces a symbol to what identifies it, dropping how the writer spelled the call. */
function canonicalSymbol(value?: string): string {
  const normalized = normalize(value);
  if (!normalized) return '';

  // Cut at the first parenthesis: a balanced match breaks on nested calls like `f(g(x))`.
  const open = normalized.indexOf('(');
  const head = (open >= 0 ? normalized.slice(0, open) : normalized).replace(/\s+/g, '').replace(/[;,]+$/, '');

  // Only an argument list: keep the written form, since an empty symbol would match the whole file.
  return head || normalized.replace(/\s+/g, '');
}

/**
 * Qualified and bare forms of the same symbol match: `orderservice.cancelasync` and `cancelasync`
 * are the same method, since both pointers already name the same file.
 */
function symbolsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Case is folded only where the filesystem folds it. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** The stored form: separators and `./` only, so the path is shown as it was written. */
function normalizeFile(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

/** The comparison form. */
function fileKey(value: string): string {
  const cleaned = normalizeFile(value);
  return CASE_INSENSITIVE_FS ? cleaned.toLowerCase() : cleaned;
}
