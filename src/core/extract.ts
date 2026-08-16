/**
 * Pulls the text of one symbol out of a source file.
 *
 * A pointer names `file::symbol`, but until now nothing acted on the symbol half: an agent
 * given a pointer still read the whole file. That is affordable for a large model and fatal
 * for a small one -- a 7B asked to enumerate something from a 400-line file ran out of turns,
 * and answered the same question from a 41-line slice in one.
 *
 * This is a heuristic, not a parser. It is deliberately language-agnostic: brace-balanced
 * for the C family, indentation-based for Python, and it gives up rather than guessing when
 * it cannot find the symbol -- the caller falls back to reading the file.
 */

export interface ExtractedSymbol {
  text: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

/** Words that appear before a name in a declaration, across the languages people use here. */
const DECLARATORS = [
  'function', 'class', 'interface', 'type', 'const', 'let', 'var', 'enum', 'struct', 'trait',
  'impl', 'def', 'fn', 'func', 'public', 'private', 'protected', 'internal', 'static', 'async',
  'export', 'abstract', 'readonly', 'override', 'record'
];

/**
 * Reduces `OrderService.CancelAsync(Guid id)` to `CancelAsync`.
 *
 * The qualifier is dropped because a method is written both ways depending on who is
 * pointing at it, and the file only contains one of the two spellings.
 */
function bareName(symbol: string): string {
  const withoutArgs = symbol.split('(')[0];
  const segments = withoutArgs.split(/[.#:]/).filter(Boolean);
  return (segments[segments.length - 1] ?? '').trim();
}

/** How strongly a line looks like the *declaration* of `name`, rather than a use of it. */
function declarationScore(line: string, name: string): number {
  const at = indexOfWord(line, name);
  if (at < 0) return 0;

  const before = line.slice(0, at);
  const after = line.slice(at + name.length);
  let score = 1;

  if (DECLARATORS.some(word => indexOfWord(before, word) >= 0)) score += 4;
  // `name(` is a call as often as a definition, but a call rarely opens a block on the
  // same line and rarely sits at the start of its line.
  if (/^\s*[(<]/.test(after)) score += 1;
  if (/[{:=]\s*$/.test(line) || /\)\s*(:[^=]*)?\s*\{\s*$/.test(line)) score += 2;
  if (before.trim() === '') score += 1;
  // A call inside an expression: `const x = compute(name(y))`.
  if (/[.\w]$/.test(before.trimEnd())) score -= 2;
  if (/^\s*(return|await|throw)\b/.test(line)) score -= 2;
  return score;
}

/** Index of `word` in `text` on word boundaries, or -1. */
function indexOfWord(text: string, word: string): number {
  if (!word) return -1;
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walks a line counting braces, ignoring the ones inside strings and comments.
 *
 * `state.inBlockComment` carries across lines; a brace inside `/* ... *\/` or a string
 * would otherwise end the block early and hand back a truncated symbol.
 */
function countBraces(line: string, state: { inBlockComment: boolean }): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '/' && next === '*') {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '/') break;
    if (char === '#' && !next?.match(/[a-zA-Z]/)) break; // Python / shell comment
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') depth++;
    if (char === '}' || char === ')' || char === ']') depth--;
  }
  return depth;
}

/** Doc comment or line comments sitting directly above the declaration. */
function commentStart(lines: string[], declaration: number): number {
  let start = declaration;
  for (let i = declaration - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') break;
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*') || line.startsWith('/*')) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

/** Drops strings and comments, so a `{` inside either is not read as an opening brace. */
function stripInline(line: string): string {
  return line
    .replace(/\/\*.*?\*\//g, '')
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\/.*$/, '');
}

const MAX_LINES = 400;

/**
 * Returns the text of `symbol` within `source`, or undefined when it cannot be located.
 *
 * Undefined is a real answer: a caller that cannot find the symbol should read the file
 * rather than be handed a confident slice of the wrong thing.
 */
export function extractSymbol(source: string, symbol: string): ExtractedSymbol | undefined {
  const name = bareName(symbol);
  if (!name) return undefined;

  const lines = source.split('\n');
  let best = -1;
  let bestScore = 1; // A bare mention is not enough on its own.
  for (let i = 0; i < lines.length; i++) {
    const score = declarationScore(lines[i], name);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return undefined;

  const startLine = commentStart(lines, best);
  const declaration = lines[best];
  const indent = declaration.length - declaration.trimStart().length;

  const state = { inBlockComment: false };
  let depth = countBraces(declaration, state);
  let endLine = best;

  if (depth <= 0 && /\{/.test(stripInline(declaration))) {
    // The body opened and closed on this line: `function f() { return 1; }`. Falling
    // through to the statement scan below would run past it, because the line ends in `}`
    // rather than `;`, and swallow whatever came next.
    endLine = best;
  } else if (depth > 0) {
    // Brace-balanced: walk until the block that opened here closes.
    for (let i = best + 1; i < lines.length && i - best < MAX_LINES; i++) {
      depth += countBraces(lines[i], state);
      endLine = i;
      if (depth <= 0) break;
    }
  } else if (/:\s*$/.test(declaration.replace(/#.*$/, '').trimEnd())) {
    // Indentation-based (Python): the body is everything indented past the declaration.
    for (let i = best + 1; i < lines.length && i - best < MAX_LINES; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        endLine = i;
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      endLine = i;
    }
    // Trailing blank lines belong to whatever comes next.
    while (endLine > best && lines[endLine].trim() === '') endLine--;
  } else {
    // A one-liner (`const x = 1;`) or a signature without a body. Continue only while the
    // statement is visibly unfinished.
    for (let i = best; i < lines.length && i - best < MAX_LINES; i++) {
      endLine = i;
      if (/[;,]\s*$/.test(lines[i]) || lines[i].trim() === '') break;
      if (i > best && /^\s*$/.test(lines[i])) break;
    }
  }

  return {
    text: lines.slice(startLine, endLine + 1).join('\n'),
    startLine: startLine + 1,
    endLine: endLine + 1
  };
}
