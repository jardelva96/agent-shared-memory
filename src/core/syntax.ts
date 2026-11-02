/**
 * Whether a source file still parses, checked before an edit is written.
 *
 * Measured with real agents: one wrote a regex without its closing slash into a file two
 * agents shared, and every test of both of them stopped loading. An edit that turns a file
 * that parsed into one that does not is refused here, with the line, and nothing is written:
 * the agent sees its mistake while it can still fix it, and nobody else inherits it.
 *
 * The real parser is used where one is at hand -- Node for JavaScript, the project's own
 * TypeScript, Python's ast -- and a bracket-and-string balance check everywhere else.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { unbalancedAt } from './extract.js';

export interface SyntaxProblem {
  line?: number;
  message: string;
}

/** The first syntax problem in `text` read as `file`, or undefined when it parses. */
export async function syntaxProblem(file: string, text: string, root: string): Promise<SyntaxProblem | undefined> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return jsonProblem(text);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return (await nodeProblem(text, ext)) ?? undefined;
  if (['.ts', '.tsx', '.mts', '.cts', '.jsx'].includes(ext)) {
    const ts = loadTypeScript(root);
    return ts ? typeScriptProblem(ts, file, text) : unbalancedAt(text);
  }
  if (ext === '.py') {
    const result = await pythonProblem(text);
    return result === null ? undefined : result;
  }
  return unbalancedAt(text);
}

function jsonProblem(text: string): SyntaxProblem | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

/** Node's own parser, through `node --check` on a copy. ESM when the file uses import/export. */
async function nodeProblem(text: string, ext: string): Promise<SyntaxProblem | undefined> {
  const moduleLike = ext === '.mjs' || (ext === '.js' && /^\s*(import|export)\b/m.test(text));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asm-check-'));
  const copy = path.join(dir, `check${moduleLike ? '.mjs' : ext === '.mjs' ? '.mjs' : '.cjs'}`);
  try {
    await writeFile(copy, text, 'utf8');
    const stderr = await run(process.execPath, ['--check', copy]);
    if (stderr === undefined) return undefined;
    const line = Number(new RegExp(`${escape(path.basename(copy))}:(\\d+)`).exec(stderr)?.[1]);
    const message = stderr.split('\n').find(l => /Error:/.test(l))?.trim() ?? 'does not parse';
    return { line: Number.isFinite(line) ? line : undefined, message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type TypeScriptModule = typeof import('typescript');

/** The project's own TypeScript first, then this package's; undefined when neither is installed. */
function loadTypeScript(root: string): TypeScriptModule | undefined {
  for (const from of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      return createRequire(from)('typescript') as TypeScriptModule;
    } catch {
      // Not installed there.
    }
  }
  return undefined;
}

function typeScriptProblem(ts: TypeScriptModule, file: string, text: string): SyntaxProblem | undefined {
  // Syntax only: type errors belong to the build, and an edit mid-refactor has plenty.
  const output = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve } });
  const first = output.diagnostics?.find(d => d.category === ts.DiagnosticCategory.Error);
  if (!first) return undefined;
  const line = first.file && first.start !== undefined ? first.file.getLineAndCharacterOfPosition(first.start).line + 1 : undefined;
  return { line, message: ts.flattenDiagnosticMessageText(first.messageText, ' ') };
}

/** Python's ast, through whichever interpreter answers. Null when there is none to ask. */
async function pythonProblem(text: string): Promise<SyntaxProblem | undefined | null> {
  const script = 'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(e.lineno, e.msg)\n sys.exit(3)';
  // On Windows `python3` can be the Store's placeholder, which answers but parses nothing;
  // anything other than "parsed" or "syntax error" moves on to the next interpreter.
  for (const [cmd, args] of [['python3', []], ['python', []], ['py', ['-3']]] as const) {
    const outcome = await runWithInput(cmd, [...args, '-I', '-c', script], text);
    if (outcome === 'missing') continue;
    if (outcome.code === 0 && outcome.stdout.trim() === '') return undefined;
    if (outcome.code === 3) {
      const [line, ...rest] = outcome.stdout.trim().split(' ');
      return { line: Number(line) || undefined, message: rest.join(' ') || 'does not parse' };
    }
  }
  return null;
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (error, _stdout, stderr) => resolve(error ? String(stderr || error.message) : undefined));
  });
}

function runWithInput(cmd: string, args: string[], input: string): Promise<{ code: number; stdout: string } | 'missing'> {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? -1 : (error as { code?: number }).code ?? 1) : 0;
      resolve(code === -1 ? 'missing' : { code: typeof code === 'number' ? code : 1, stdout: String(stdout) });
    });
    child.on('error', () => resolve('missing'));
    child.stdin?.end(input);
  });
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
