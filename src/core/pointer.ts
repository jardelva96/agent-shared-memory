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
  return [normalizeFile(pointer.file), normalize(pointer.symbol), normalize(pointer.parameter)]
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
  const fileA = normalizeFile(a.file);
  const fileB = normalizeFile(b.file);
  if (fileA !== fileB) return { overlap: false, exact: false };

  const symbolA = normalize(a.symbol);
  const symbolB = normalize(b.symbol);
  const parameterA = normalize(a.parameter);
  const parameterB = normalize(b.parameter);

  if (!symbolA || !symbolB) {
    return { overlap: true, exact: pointerKey(a) === pointerKey(b) };
  }

  if (symbolA !== symbolB) return { overlap: false, exact: false };
  if (parameterA && parameterB && parameterA !== parameterB) {
    return { overlap: true, exact: false };
  }

  return { overlap: true, exact: pointerKey(a) === pointerKey(b) };
}

function normalize(value?: string): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeFile(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}
