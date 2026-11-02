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
  /** 1-based, inclusive. Includes the doc comment above the declaration. */
  startLine: number;
  /** 1-based: the line that names the symbol, after its doc comment and attributes. */
  declarationLine: number;
  endLine: number;
}

/** Words that appear before a name in a declaration, across the languages people use here. */
const DECLARATORS = [
  'function', 'class', 'interface', 'type', 'const', 'let', 'var', 'enum', 'struct', 'trait',
  'impl', 'def', 'fn', 'func', 'public', 'private', 'protected', 'internal', 'static', 'async',
  'export', 'abstract', 'readonly', 'override', 'record', 'delegate', 'fun', 'val'
];

/**
 * The declarators that say what kind of thing comes next. Directly before a name they mean
 * this line declares it. A modifier does not: in C# and Java the word after `public` is
 * usually the type (`public EscolaStatus Status`), not the name being declared.
 */
const KIND_WORDS = new Set([
  'function', 'class', 'interface', 'type', 'const', 'let', 'var', 'enum', 'struct', 'trait',
  'impl', 'def', 'fn', 'func', 'record', 'delegate', 'fun', 'val'
]);

/** Words after which a name is being used, never declared: `return x`, `await f()`, `new T()`. */
const USE_WORDS = new Set([
  'return', 'await', 'new', 'throw', 'yield', 'typeof', 'nameof', 'sizeof', 'instanceof', 'keyof',
  'in', 'of', 'is', 'as', 'case', 'else', 'extends', 'implements', 'not', 'and', 'or', 'import', 'using'
]);

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
  // Strings and comments are blanked first: `@Get('overview') overview()` names the method
  // twice, and the first mention, inside the quotes, is not code. Decorators in front of the
  // declaration go too (`@IsString() @MaxLength(220) title!: string;`).
  const code = maskLiterals(line).replace(/^\s*(?:@[\w.]+(?:\([^()]*\))?\s*)+/, m => ' '.repeat(m.length));
  const at = indexOfWord(code, name);
  if (at < 0) return 0;

  const before = code.slice(0, at);
  const after = code.slice(at + name.length);
  const tail = before.trimEnd();
  const wordBefore = /[\w$]+$/.exec(tail)?.[0];
  let score = 1;

  if (DECLARATORS.some(word => indexOfWord(before, word) >= 0)) score += 4;
  // `name(` is a call as often as a definition, but a call rarely opens a block on the
  // same line and rarely sits at the start of its line.
  if (/^\s*[(<]/.test(after)) score += 1;
  if (/[{:=]\s*$/.test(code) || /\)\s*(:[^=]*)?\s*\{\s*$/.test(code)) score += 2;
  if (tail === '') score += 1;
  // Right after `interface`, `def`, `enum`... the name is being declared; further along the
  // same line it is only a parameter or a return type.
  if (wordBefore && KIND_WORDS.has(wordBefore)) score += 3;
  // In expression position the name is being used: an argument, the value of an assignment,
  // a type annotation, a member access, `return name`. A type word before it is not on the
  // list -- `bool Name(` and `string? Name` are how C# and Java declare, and penalising any
  // word there handed `private bool MexeNoAcervo()` to `var acervo = MexeNoAcervo();`.
  if (/(=|=>|->|\(|,|:|<|\||&|!|\[|\.|\{)$/.test(tail) || (wordBefore && USE_WORDS.has(wordBefore))) score -= 3;
  if (/^\s*(return|await|throw)\b/.test(code)) score -= 2;
  return score;
}

/**
 * The line with the inside of every string and comment replaced by spaces, so positions
 * still match the original. A line that starts inside a block comment (` * ...`) is all
 * comment.
 */
export function maskLiterals(line: string): string {
  if (/^\s*(\/\*|\*(\s|\/|$))/.test(line)) return ' '.repeat(line.length);
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
        out += char;
      } else {
        out += ' ';
        if (char === '\\' && i + 1 < line.length) {
          out += ' ';
          i++;
        }
      }
      continue;
    }
    if ((char === '/' && line[i + 1] === '/') || isHashComment(line, i)) {
      return out + ' '.repeat(line.length - i);
    }
    // A regex literal is text too: `/[{(]/` holds a brace and a parenthesis that open nothing.
    if (char === '/' && line[i + 1] !== '*') {
      const end = regexEnd(line, i);
      if (end > 0) {
        out += `/${' '.repeat(end - i - 1)}/`;
        i = end;
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    out += char;
  }
  return out;
}

/** `#` that starts a Python or shell comment, not a C# directive mid-line or a JS `#private`. */
function isHashComment(line: string, i: number): boolean {
  return line[i] === '#' && (line.slice(0, i).trim() === '' || /\s/.test(line[i + 1] ?? ' '));
}

/**
 * Where a regular-expression literal that starts at `i` ends, or -1 when the `/` is division.
 *
 * `/[{:=]\s*$/` holds a brace, and counting it as code left the block open to the end of
 * the file. A `/` begins a regex where a value is expected: after an operator, an opening
 * bracket, a comma, or at the start of the line.
 */
export function regexEnd(line: string, i: number): number {
  const previous = line.slice(0, i).trimEnd();
  if (!(previous === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || /\b(return|typeof|case)$/.test(previous))) {
    return -1;
  }
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const char = line[j];
    if (char === '\\') {
      j++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return j;
  }
  return -1;
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
function countBraces(line: string, state: { inBlockComment: boolean; sawBrace?: boolean; openQuote?: string }): number {
  let depth = 0;
  // A template literal or a raw string can span lines, and the braces in a help text written
  // inside one are not code. Any other string ends with its line.
  let quote: string | undefined = state.openQuote;
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
      if (quote === '"""') {
        if (line.startsWith(quote, i)) {
          quote = undefined;
          i += 2;
        }
      } else if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (line.startsWith('"""', i)) {
      quote = '"""';
      i += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '/') break;
    if (isHashComment(line, i)) break;
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/') {
      const end = regexEnd(line, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (char === '{') state.sawBrace = true;
    if (char === '{' || char === '(' || char === '[') depth++;
    if (char === '}' || char === ')' || char === ']') depth--;
  }
  state.openQuote = quote === '`' || quote === '"""' ? quote : undefined;
  return depth;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The Python triple quote still open after `line`, given the one open before it. */
function openTripleQuote(line: string, open: string | undefined): string | undefined {
  let i = 0;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf(open, i);
      if (end < 0) return open;
      i = end + 3;
      open = undefined;
    } else {
      const found = /"""|'''|#/.exec(line.slice(i));
      if (!found || found[0] === '#') return undefined;
      open = found[0];
      i += found.index + 3;
    }
  }
  return open;
}

/** A line that begins another declaration at the same level or above: the previous one ended. */
function startsDeclaration(line: string, indent: number): boolean {
  const lineIndent = line.length - line.trimStart().length;
  return (
    lineIndent <= indent &&
    /^\s*(@|(export|declare|import|type|interface|const|let|var|function|class|enum|abstract|async|public|private|protected|internal|static|readonly|def)\b)/.test(line)
  );
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
  const lines = source.split('\n');
  const best = findDeclaration(lines, symbol);
  return best === undefined ? undefined : sliceAt(lines, best);
}

/**
 * The 0-based line that declares `symbol`, or undefined. Exported for the tools that need
 * the line itself -- an edit that replaces a symbol, a search across files -- rather than
 * the text around it.
 */
export function findDeclaration(lines: string[], symbol: string): number | undefined {
  const name = bareName(symbol);
  if (!name) return undefined;

  // `OrderService.CancelAsync` is looked for inside OrderService first. A member's bare name
  // is often also a local somewhere else in the file (`status`, `config`), and a local
  // declaration outscores a property; the qualifier is what the pointer means.
  const segments = symbol.split('(')[0].split(/[.#]|::/).map(s => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    const container = findDeclaration(lines, segments.slice(0, -1).join('.'));
    if (container !== undefined) {
      // The whole type, however long: a member past line 400 of a class is still its member.
      const range = sliceAt(lines, container, Infinity);
      // Members sit at one indentation; a local of the same name inside a method sits deeper,
      // and `const config = {` outscores `async config() {` on its own.
      const firstMember = lines.slice(container + 1, range.endLine).find(line => line.trim() !== '' && !/^\s*[{}]\s*$/.test(line));
      const inside = bestDeclaration(lines, name, container + 1, range.endLine, firstMember === undefined ? undefined : indentOf(firstMember));
      if (inside !== undefined) return inside;
    }
  }
  return bestDeclaration(lines, name, 0, lines.length);
}

/** The best-scoring declaration of `name` between 0-based `from` (inclusive) and `to` (exclusive). */
function bestDeclaration(lines: string[], name: string, from: number, to: number, memberIndent?: number): number | undefined {
  let best = -1;
  let bestScore = 1; // A bare mention is not enough on its own.
  for (let i = from; i < to; i++) {
    let score = declarationScore(lines[i], name);
    if (score > 1 && memberIndent !== undefined && indentOf(lines[i]) === memberIndent) score += 4;
    // On a tie the shallower line wins: `const config = await this.config();` inside a method
    // scores like the `config()` method it calls, and a pointer means the member, not a local.
    if (score > bestScore || (score === bestScore && best >= 0 && indentOf(lines[i]) < indentOf(lines[best]))) {
      bestScore = score;
      best = i;
    }
  }
  return best < 0 ? undefined : best;
}

/** The symbol whose declaration is on 0-based line `best`, with its doc comment. */
export function sliceAt(lines: string[], best: number, maxLines = MAX_LINES): ExtractedSymbol {
  const startLine = commentStart(lines, best);
  const declaration = lines[best];
  const indent = declaration.length - declaration.trimStart().length;

  const state: { inBlockComment: boolean; sawBrace: boolean; openQuote?: string } = { inBlockComment: false, sawBrace: false };
  let endLine = best;

  const pythonHeader =
    countBraces(declaration, { inBlockComment: false }) === 0 &&
    !/\{/.test(stripInline(declaration)) &&
    /:\s*$/.test(declaration.replace(/#.*$/, '').trimEnd());

  if (!pythonHeader) {
    // Brace-balanced, from the declaration line on. The body does not have to open on that
    // line: C# and Java put `{` on the next one, and a long signature spans several. So the
    // walk ends when a block that opened has closed, or -- before any block opened -- when a
    // statement ends (`const x = 1;`). Stopping at the first balanced line instead handed back
    // a bare signature, or an enum with only its first member.
    let depth = 0;
    let opened = false;
    for (let i = best; i < lines.length && i - best < maxLines; i++) {
      // A signature with no body, followed by a gap: whatever comes next is not part of it.
      // Without semicolons (`type A = B` then `type C = D`) a statement also ends where the
      // next declaration begins.
      const inString = Boolean(state.openQuote);
      if (i > best && !opened && depth <= 0 && !inString && (lines[i].trim() === '' || startsDeclaration(lines[i], indent))) break;
      // With no terminator at all (Python's `RAIZ = Path(...)` followed by `CONFIG = ...`), a
      // finished statement is followed by a line at its own indentation. Not when the line
      // before visibly continues, and not for a body brace on its own line (C#, Java).
      if (
        i > best && !opened && depth <= 0 && !inString &&
        indentOf(lines[i]) <= indent &&
        !/(=>|[([{,\\=+\-*/&|?:.])\s*$/.test(lines[i - 1]) &&
        !/^\s*([{:]|where\b)/.test(lines[i])
      ) break;
      depth += countBraces(lines[i], state);
      opened ||= state.sawBrace;
      endLine = i;
      // Inside a multi-line string a blank line or a trailing comma is text, not an ending.
      if (state.openQuote) continue;
      if (depth <= 0 && (opened || /[;,]\s*$/.test(lines[i]))) {
        // `type T =\n  | { a: 1 }\n  | { b: 2 };` closes a brace on every line and is still
        // one statement: a next line that starts with an operator carries it on.
        const next = lines.slice(i + 1, i + 4).find(line => line.trim() !== '');
        if (!/[;,]\s*$/.test(lines[i]) && next && /^\s*(\||&|\?|:|\+|=>)/.test(next)) continue;
        break;
      }
    }
  } else {
    // Indentation-based (Python): the body is everything indented past the declaration,
    // except that a triple-quoted string may sit at any indentation until it closes.
    let open: string | undefined;
    for (let i = best + 1; i < lines.length && i - best < maxLines; i++) {
      const line = lines[i];
      if (!open) {
        if (line.trim() === '') {
          endLine = i;
          continue;
        }
        if (indentOf(line) <= indent) break;
      }
      endLine = i;
      open = openTripleQuote(line, open);
    }
    // Trailing blank lines belong to whatever comes next.
    while (endLine > best && lines[endLine].trim() === '') endLine--;
  }

  return {
    text: lines.slice(startLine, endLine + 1).join('\n'),
    startLine: startLine + 1,
    declarationLine: best + 1,
    endLine: endLine + 1
  };
}
