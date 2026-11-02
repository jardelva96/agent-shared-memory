/**
 * Working with code by symbol instead of by file: what a file declares, where a name is
 * declared across the project, where it is used, and changing one symbol in place.
 *
 * It needs no language server, so it works the moment the package is installed, in any of
 * the languages extractSymbol reads. The price is that it is a heuristic: it is measured
 * against the compilers' own spans in bench/, and it says "not found" rather than guess.
 *
 * The edit is the part that matters for several agents. An agent that rewrites a whole file
 * from a copy it read earlier erases whatever another agent changed in between -- measured,
 * not hypothetical. An edit here names one symbol, re-reads the file under a lock at the
 * moment it applies, and replaces only that symbol's lines, so two agents changing two
 * functions of the same file both keep their work.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/fs.js';
import { findDeclaration, maskLiterals, regexEnd, sliceAt } from './extract.js';
import { resolvePaths } from './paths.js';
import { syntaxProblem } from './syntax.js';
import { parsePointer } from './pointer.js';

export interface OutlineEntry {
  name: string;
  /** class, interface, struct, record, enum, trait, type, function, method, property, const. */
  kind: string;
  /** The type it is declared in, for members. */
  container?: string;
  /** 1-based. startLine includes the doc comment; declarationLine is the line naming it. */
  startLine: number;
  declarationLine: number;
  endLine: number;
}

export interface SymbolMatch extends OutlineEntry {
  file: string;
  pointer: string;
}

export interface ReferenceMatch {
  file: string;
  line: number;
  text: string;
}

export type EditMode = 'replace' | 'insert_after' | 'insert_before';

export interface EditResult {
  file: string;
  symbol: string;
  mode: EditMode;
  /** 1-based lines of the code as written. */
  fromLine: number;
  toLine: number;
  removedLines: number;
}

const MODIFIERS =
  '(?:(?:public|private|protected|internal|static|async|override|virtual|abstract|readonly|sealed|partial|extern|unsafe|new|final|' +
  'synchronized|get|set|declare|required|const|volatile|delegate|export|default|pub|open|data)\\s+)*';
// A type as C# and TypeScript write it before a name: `Task<(int, string)>`, `string?`,
// `Dictionary<string, DateTime>`, `int[]`, or a tuple `(string Texto, int N)`.
const TYPE = '(?:[\\w$.?]+(?:<[^=;{}]*>)?(?:\\[\\])*\\??|\\([^()]*\\)(?:\\[\\])*\\??)\\s+';
// Anchored at the start of the line, after modifiers only: `(object linha` in a parameter
// list is not a declaration of `linha`.
// Also after `;`, `}` or a decorator's `)`: compacted files put several declarations on one
// line (`@Injectable()export class Guard{...}`).
const LEAD = '(?:^|[;})])\\s*';
const TYPE_WORDS = new RegExp(`${LEAD}${MODIFIERS}(class|interface|struct|record|enum|trait|namespace|module|impl)\\s+([A-Za-z_$][\\w$]*)`);
const FUNCTION_WORDS = new RegExp(`${LEAD}${MODIFIERS}(?:function\\*?|def|fn|func|fun)\\s+([A-Za-z_$][\\w$]*)`);
// The generic list may hold its own `=` (`type Params<T = any> = ...`), so it is matched lazily.
const TYPE_ALIAS = new RegExp(`${LEAD}${MODIFIERS}type\\s+([A-Za-z_$][\\w$]*)\\s*(?:<.*?>)?\\s*=`);
const TOP_BINDING = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
// `string IServicoPago.Prefixo =>` implements an interface member by its qualified name.
const QUALIFIED = '(?:[A-Za-z_$][\\w$]*\\.)*';
const METHOD = new RegExp(`^\\s*${MODIFIERS}(?:${TYPE})?${QUALIFIED}([A-Za-z_$][\\w$]*)\\s*(?:<[^()=;{}]*>)?\\s*\\(`);
const MEMBER = new RegExp(`^\\s*${MODIFIERS}(?:${TYPE})?${QUALIFIED}([A-Za-z_$][\\w$]*)\\s*[?!]?\\s*(?:\\{|=>|=(?!=)|;|:(?!:)|$)`);
/** A line that visibly goes on: what follows is the rest of an expression, not a member. */
const CONTINUES = /(=>|[=(,?:+\-*/&|.]|\b(?:return|await|new))\s*$/;
const NOT_A_NAME = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'else', 'throw', 'await', 'typeof',
  'sizeof', 'nameof', 'base', 'this', 'super', 'function', 'fixed', 'checked', 'unchecked', 'default', 'case', 'when', 'yield',
  'do', 'try', 'finally', 'where', 'select', 'from', 'in', 'of', 'is', 'as'
]);
// C# accessors (`get; set;`, `init;`, `add { }`) look like members; a method may still be named so.
const ACCESSORS = new Set(['get', 'set', 'init', 'add', 'remove', 'value'
]);

type Block = 'ns' | 'type' | 'enum' | 'body';

/**
 * The declarations of a file a reader would want to see first: everything at the top level,
 * and the members of the types declared there. What is declared inside a function body is
 * an implementation detail, and listing it would bury the outline.
 */
export function outlineSymbols(source: string, file = ''): OutlineEntry[] {
  const lines = source.split('\n').map(line => line.replace(/\r$/, ''));
  return /\.py$/i.test(file) || (!/[{}]/.test(source) && /^\s*(def|class)\s/m.test(source))
    ? outlineIndented(lines)
    : outlineBraced(lines, /\.(cs|java|kt|kts|go|rs|swift|c|cc|cpp|h|hpp|scala|dart)$/i.test(file));
}

function entry(lines: string[], index: number, name: string, kind: string, container?: string): OutlineEntry {
  const slice = sliceAt(lines, index);
  return { name, kind, container, startLine: slice.startLine, declarationLine: slice.declarationLine, endLine: slice.endLine };
}

function outlineBraced(lines: string[], typedLanguage: boolean): OutlineEntry[] {
  const found: OutlineEntry[] = [];
  const blocks: Array<{ kind: Block; name?: string }> = [];
  let pending: { kind: Block; name?: string } | undefined;
  // Open parentheses and brackets carried across lines: a lambda inside a multi-line
  // argument list (`new(\n  v => v.ToUniversalTime(),`) sits at member level but declares nothing.
  let parens = 0;
  // A template literal or a C# raw string that spans lines: its lines are text.
  let multiline: string | undefined;
  let previous = '';

  for (let i = 0; i < lines.length; i++) {
    let code: string;
    let tail = false;
    if (multiline) {
      const close = lines[i].indexOf(multiline);
      if (close < 0) continue;
      const after = close + multiline.length;
      code = ' '.repeat(after) + maskLiterals(lines[i].slice(after));
      multiline = opensMultiline(lines[i].slice(after));
      tail = true;
    } else {
      // Decorators and attributes sit in front of the declaration on the same line in some
      // styles (`@Get('x') list() {`, `[HttpGet] public IActionResult List()`).
      code = maskLiterals(lines[i]).replace(/^\s*(?:(?:@[\w.]+(?:\([^()]*\))?|\[[^\]]*\])\s*)+/, m => ' '.repeat(m.length));
      multiline = opensMultiline(lines[i]);
    }
    const open = blocks.filter(b => b.kind !== 'ns');
    const context = open.length === 0 ? 'top' : open[open.length - 1].kind;
    const container = open.length > 0 ? open[open.length - 1].name : undefined;
    const continuing = CONTINUES.test(previous.replace(/\/\*.*?\*\//g, '').trimEnd());
    if (code.trim()) previous = code;

    if (code.trim() && !tail && !continuing && parens <= 0 && (context === 'top' || context === 'type')) {
      const type = TYPE_WORDS.exec(code);
      const alias = TYPE_ALIAS.exec(code);
      const fn = FUNCTION_WORDS.exec(code);
      if (type) {
        const kind = type[1] === 'namespace' || type[1] === 'module' ? 'ns' : type[1] === 'enum' ? 'enum' : 'type';
        if (kind !== 'ns') found.push(entry(lines, i, type[2], type[1], container));
        pending = { kind, name: type[2] };
      } else if (alias) {
        found.push(entry(lines, i, alias[1], 'type', container));
        pending = { kind: 'body' };
      } else if (fn) {
        found.push(entry(lines, i, fn[1], context === 'type' ? 'method' : 'function', container));
        pending = { kind: 'body' };
      } else if (context === 'top') {
        // C# top-level statements declare locals, not members of anything.
        const binding = !typedLanguage && /^\S/.test(lines[i]) ? TOP_BINDING.exec(code) : null;
        if (binding) {
          found.push(entry(lines, i, binding[1], 'const'));
          pending = { kind: 'body' };
        }
      } else {
        // Inside a type body every `name(` is a declaration: a type holds no statements.
        const method = METHOD.exec(code);
        const member = method ? null : MEMBER.exec(code);
        const name = method?.[1] ?? member?.[1];
        if (name && !NOT_A_NAME.has(name) && (method || !ACCESSORS.has(name))) {
          found.push(entry(lines, i, name, method ? 'method' : 'property', container));
          pending = { kind: 'body' };
        }
      }
    }

    for (const char of code) {
      if (char === '{') {
        blocks.push(pending ?? { kind: 'body' });
        pending = undefined;
      } else if (char === '}') {
        blocks.pop();
      } else if (char === '(' || char === '[') {
        parens++;
      } else if (char === ')' || char === ']') {
        parens = Math.max(0, parens - 1);
      }
    }
    // A declaration that ended without a body (`void Run();`, `record Point(int X);`).
    if (/;\s*$/.test(code)) pending = undefined;
  }
  return found;
}

/** The template literal (`) or raw string (""") a line leaves open, if any. */
function opensMultiline(line: string): string | undefined {
  let open: string | undefined;
  for (let i = 0; i < line.length; i++) {
    if (open) {
      if (line.startsWith(open, i) && (open !== '`' || line[i - 1] !== '\\')) {
        i += open.length - 1;
        open = undefined;
      }
      continue;
    }
    if (line.startsWith('//', i)) break;
    // A regex literal can hold quotes and backticks (`/"""|'''/`) that open nothing.
    if (line[i] === '/' && line[i + 1] !== '*') {
      const end = regexEnd(line, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (line.startsWith('"""', i)) {
      open = '"""';
      i += 2;
    } else if (line[i] === '`') {
      open = '`';
    } else if (line[i] === '"' || line[i] === "'") {
      // An ordinary string closes on its line; skip it so a backtick inside it opens nothing.
      const quote = line[i];
      for (i++; i < line.length && line[i] !== quote; i++) if (line[i] === '\\') i++;
    }
  }
  return open;
}

function outlineIndented(lines: string[]): OutlineEntry[] {
  const found: OutlineEntry[] = [];
  const stack: Array<{ indent: number; kind: 'class' | 'def'; name: string }> = [];
  let inString: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInString = inString;
    inString = tripleQuoteAfter(line, inString);
    if (wasInString || !line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.length - line.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const listed = stack.every(s => s.kind === 'class') && stack.length <= 1;

    const def = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (def) {
      if (listed) found.push(entry(lines, i, def[2], def[1] === 'class' ? 'class' : parent ? 'method' : 'function', parent?.name));
      stack.push({ indent, kind: def[1] as 'class' | 'def', name: def[2] });
      continue;
    }
    const constant = indent === 0 ? /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/.exec(line) : null;
    if (constant) found.push(entry(lines, i, constant[1], 'const'));
  }
  return found;
}

function tripleQuoteAfter(line: string, open: string | undefined): string | undefined {
  let rest = line;
  while (rest) {
    if (open) {
      const end = rest.indexOf(open);
      if (end < 0) return open;
      rest = rest.slice(end + 3);
      open = undefined;
    } else {
      const start = /"""|'''/.exec(rest);
      if (!start) return undefined;
      open = start[0];
      rest = rest.slice(start.index + 3);
    }
  }
  return open;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', '.next', '.nuxt', 'coverage', 'vendor', '.venv', 'venv',
  '__pycache__', '.agents', 'target', '.idea', '.vs', '.vscode', '.gradle', '.dart_tool', '.turbo', '.cache'
]);
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|cs|java|kt|kts|go|rs|rb|php|swift|c|cc|cpp|h|hpp|scala|dart|lua|vue|svelte)$/i;
const MAX_FILE_BYTES = 1_000_000;

/** Every source file under `dir`, skipping dependencies, build output and this tool's own folder. */
export async function* codeFiles(root: string, dir = root, budget = { left: 20_000 }): AsyncGenerator<string> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (budget.left <= 0) return;
    const full = path.join(dir, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) yield* codeFiles(root, full, budget);
    } else if (CODE_FILE.test(name) && info.size <= MAX_FILE_BYTES && !/\.d\.ts$/.test(name)) {
      budget.left--;
      yield full;
    }
  }
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function bareName(symbol: string): string {
  const withoutArgs = symbol.split('(')[0];
  const segments = withoutArgs.split(/[.#:]/).filter(Boolean);
  return (segments[segments.length - 1] ?? '').trim();
}

/** Where `symbol` is declared, across the project. A qualified name (`Order.Cancel`) narrows by container. */
export async function findSymbol(root: string, symbol: string, limit = 20): Promise<SymbolMatch[]> {
  const name = bareName(symbol);
  const qualifier = symbol.includes('.') ? symbol.split('(')[0].split('.').slice(-2, -1)[0] : undefined;
  if (!name) return [];
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  const matches: SymbolMatch[] = [];
  for await (const file of codeFiles(root)) {
    const source = await readFile(file, 'utf8').catch(() => '');
    if (!word.test(source)) continue;
    for (const item of outlineSymbols(source, file)) {
      if (item.name !== name || (qualifier && item.container && item.container !== qualifier)) continue;
      const rel = relative(root, file);
      matches.push({ ...item, file: rel, pointer: `${rel}::${item.container ? `${item.container}.` : ''}${item.name}` });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

/** Lines that use `symbol`, outside strings and comments and other than its own declaration. */
export async function findReferences(root: string, symbol: string, limit = 100): Promise<ReferenceMatch[]> {
  const name = bareName(symbol);
  if (!name) return [];
  const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  const found: ReferenceMatch[] = [];
  for await (const file of codeFiles(root)) {
    const source = await readFile(file, 'utf8').catch(() => '');
    if (!word.test(source)) continue;
    const declared = new Set(outlineSymbols(source, file).filter(s => s.name === name).map(s => s.declarationLine));
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (declared.has(i + 1) || !word.test(maskLiterals(lines[i]))) continue;
      found.push({ file: relative(root, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * Changes one symbol of a file in place: replaces it, or inserts code right after or before it.
 *
 * The file is read under a lock at the moment the edit applies -- never from a copy the
 * agent read earlier -- so a change another agent made elsewhere in the file survives. Code
 * written without indentation is indented like the symbol it replaces. When the new code
 * brings its own doc comment, attribute or decorator, it replaces the old one instead of
 * stacking on top of it.
 */
export async function editSymbol(
  root: string,
  pointer: string,
  code: string,
  mode: EditMode = 'replace',
  options: { checkSyntax?: boolean } = {}
): Promise<EditResult> {
  const parsed = parsePointer(pointer);
  if (!parsed?.file || !parsed.symbol) throw new Error(`Not a symbol pointer: ${JSON.stringify(pointer)}. Use "file::symbol".`);
  const base = path.resolve(root);
  const target = path.resolve(base, parsed.file);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Outside the project: ${parsed.file}`);

  const lockName = createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);
  return withFileLock(path.join(resolvePaths(base).locksDir, `edit-${lockName}.lock`), async () => {
    const source = await readFile(target, 'utf8');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    const declaration = findDeclaration(lines, parsed.symbol!);
    if (declaration === undefined) {
      throw new Error(`Symbol ${JSON.stringify(parsed.symbol)} was not found in ${parsed.file}. Read the file to check the name.`);
    }
    const slice = sliceAt(lines, declaration);
    const indent = /^\s*/.exec(lines[declaration])![0];

    const incoming = code.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    const firstReal = incoming.find(line => line.trim() !== '') ?? '';
    const written = indent && !/^\s/.test(firstReal) ? incoming.map(line => (line.trim() ? indent + line : line)) : incoming;

    // Where the old symbol begins: its attributes and decorators belong to it too.
    let attributes = declaration;
    while (attributes > 0 && /^\s*(@|\[)/.test(lines[attributes - 1])) attributes--;
    const bringsHeader = /^\s*(\/\/|\/\*|\*|#|@|\[|""")/.test(firstReal);
    const start = mode === 'replace' ? (bringsHeader ? Math.min(slice.startLine - 1, attributes) : declaration) : slice.startLine - 1;
    const end = slice.endLine - 1;

    let fromLine: number;
    let removedLines = 0;
    if (mode === 'replace') {
      removedLines = end - start + 1;
      lines.splice(start, removedLines, ...written);
      fromLine = start + 1;
    } else if (mode === 'insert_after') {
      lines.splice(end + 1, 0, '', ...written);
      fromLine = end + 3;
    } else {
      const before = Math.min(start, attributes);
      lines.splice(before, 0, ...written, '');
      fromLine = before + 1;
    }

    const next = lines.join(eol);
    const relPosix = rel.split(path.sep).join('/');
    // A change that turns a file that parsed into one that does not is refused, with the
    // line: the agent fixes it now, and nobody sharing the file inherits it. A file that was
    // already broken is not held to it -- the edit may be the fix.
    if (options.checkSyntax !== false) {
      const after = await syntaxProblem(relPosix, next, base);
      if (after && !(await syntaxProblem(relPosix, source, base))) {
        throw new Error(
          `Not written: this change breaks the syntax of ${relPosix}${after.line ? ` at line ${after.line}` : ''}: ${after.message}. ` +
            'Fix the code and send it again.'
        );
      }
    }
    await atomicWrite(target, next);
    return { file: relPosix, symbol: parsed.symbol!, mode, fromLine, toLine: fromLine + written.length - 1, removedLines };
  });
}

export interface RenamePlan {
  /** What was looked up and what it becomes. */
  from: string;
  to: string;
  declaration?: SymbolMatch;
  /** Every line that changes, declaration included. */
  changes: Array<{ file: string; line: number; before: string; after: string }>;
  /** Why the rename cannot be done safely, when it cannot. */
  refused?: string;
  applied: boolean;
}

/**
 * Renames a symbol everywhere it is used, as a plan first and on disk only when asked.
 *
 * Without a type checker a use is a matching word outside strings and comments, so a name
 * declared more than once in the project is refused: it cannot be told which of them a use
 * means, and a wrong rename is worse than none. Each file is re-read under the edit lock and
 * syntax-checked before it is written.
 */
export async function renameSymbol(root: string, symbol: string, to: string, options: { apply?: boolean } = {}): Promise<RenamePlan> {
  const from = bareName(symbol);
  const plan: RenamePlan = { from, to, changes: [], applied: false };
  if (!/^[A-Za-z_$][\w$]*$/.test(to)) return { ...plan, refused: `Not a valid name: ${JSON.stringify(to)}.` };
  if (to === from) return { ...plan, refused: 'The new name is the old one.' };

  const declarations = await findSymbol(root, from, 50);
  if (declarations.length === 0) return { ...plan, refused: `${from} is not declared anywhere in the project.` };
  if (declarations.length > 1) {
    return {
      ...plan,
      refused:
        `${from} is declared ${declarations.length} times (${declarations.slice(0, 5).map(d => d.pointer).join(', ')}). ` +
        'A rename by name cannot tell their uses apart; rename them by hand.'
    };
  }
  if ((await findSymbol(root, to, 1)).length > 0) return { ...plan, refused: `${to} is already declared in the project.` };
  plan.declaration = declarations[0];

  const word = new RegExp(`(?<![\w$])${from.replace(/[$]/g, '\$')}(?![\w$])`, 'g');
  const touched = new Map<string, number[]>();
  for await (const file of codeFiles(root)) {
    const source = await readFile(file, 'utf8').catch(() => '');
    if (!source.includes(from)) continue;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const masked = maskLiterals(lines[i]);
      if (!new RegExp(word.source).test(masked)) continue;
      const after = renameInLine(lines[i], masked, word, to);
      const rel = relative(root, file);
      plan.changes.push({ file: rel, line: i + 1, before: lines[i].trim(), after: after.trim() });
      touched.set(file, [...(touched.get(file) ?? []), i]);
    }
  }
  if (!options.apply) return plan;

  const base = path.resolve(root);
  for (const [file, lineNumbers] of touched) {
    const rel = path.relative(base, file);
    const lockName = createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);
    await withFileLock(path.join(resolvePaths(base).locksDir, `edit-${lockName}.lock`), async () => {
      const source = await readFile(file, 'utf8');
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const lines = source.split(/\r?\n/);
      for (const i of lineNumbers) lines[i] = renameInLine(lines[i], maskLiterals(lines[i]), word, to);
      const next = lines.join(eol);
      const relPosix = rel.split(path.sep).join('/');
      const broken = await syntaxProblem(relPosix, next, base);
      if (broken && !(await syntaxProblem(relPosix, source, base))) {
        throw new Error(`Rename stopped at ${relPosix}: it would break the syntax at line ${broken.line ?? '?'} (${broken.message}). Files before it were renamed.`);
      }
      await atomicWrite(file, next);
    });
  }
  return { ...plan, applied: true };
}

/** Replaces the word only where the masked line shows code, so strings and comments keep it. */
function renameInLine(line: string, masked: string, word: RegExp, to: string): string {
  let out = '';
  let last = 0;
  for (const match of masked.matchAll(new RegExp(word.source, 'g'))) {
    out += line.slice(last, match.index) + to;
    last = match.index! + match[0].length;
  }
  return out + line.slice(last);
}
