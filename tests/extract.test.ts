import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractSymbol } from '../src/core/extract.js';

test('a function comes back whole, with its doc comment', () => {
  const source = [
    'const before = 1;',
    '',
    '/** Adds two numbers. */',
    'export function soma(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'const after = 2;'
  ].join('\n');

  const found = extractSymbol(source, 'soma')!;
  assert.match(found.text, /Adds two numbers/, 'the comment explains the symbol, so it comes too');
  assert.match(found.text, /return a \+ b;/);
  assert.doesNotMatch(found.text, /const after/, 'and stops at the closing brace');
  assert.equal(found.startLine, 3);
  assert.equal(found.endLine, 6);
});

test('a call is not mistaken for the declaration', () => {
  const source = [
    'function caller() {',
    '  return soma(1, 2);',
    '}',
    '',
    'export function soma(a, b) {',
    '  return a + b;',
    '}'
  ].join('\n');

  const found = extractSymbol(source, 'soma')!;
  assert.match(found.text, /export function soma/);
  assert.doesNotMatch(found.text, /function caller/);
});

test('a type used in a signature is not mistaken for its declaration', () => {
  // The shape of src/mcp/tools.ts, where asking for ToolDefinition handed back buildTools.
  const source = [
    'export interface Item {',
    '  name: string;',
    '}',
    '',
    'export function build(x?: string): Item[] {',
    '  return [];',
    '}',
    '',
    'class Holder {',
    '  private item: Item;',
    '}'
  ].join('\n');

  const found = extractSymbol(source, 'Item')!;
  assert.equal(found.startLine, 1);
  assert.equal(found.endLine, 3);

  // Not won on order: with the use first, the declaration still comes back.
  const useFirst = ['def make() -> Item:', '    return Item()', '', 'class Item:', '    name = ""'].join('\n');
  const python = extractSymbol(useFirst, 'Item')!;
  assert.match(python.text, /^class Item:/);
});

test('a brace inside a string or comment does not end the block early', () => {
  const source = [
    'export function render() {',
    '  const template = "} not the end {";',
    '  /* } neither is this */',
    '  return template;',
    '}',
    'const after = 1;'
  ].join('\n');

  const found = extractSymbol(source, 'render')!;
  assert.match(found.text, /return template;/, 'the body survived the decoys');
  assert.doesNotMatch(found.text, /const after/);
});

test('an interface and a class are found the same way', () => {
  const source = [
    'export interface ProjectConfig {',
    '  staleAfterSeconds: number;',
    '  maxReviewRounds: number;',
    '}',
    '',
    'export class TaskStore {',
    '  read() {}',
    '}'
  ].join('\n');

  assert.match(extractSymbol(source, 'ProjectConfig')!.text, /maxReviewRounds/);
  const store = extractSymbol(source, 'TaskStore')!;
  assert.match(store.text, /read\(\) \{\}/);
  assert.doesNotMatch(store.text, /staleAfterSeconds/);
});

test('a qualified pointer finds the bare method in the file', () => {
  // Pointers are written both ways depending on who wrote them; the file has one spelling.
  const source = ['class OrderService {', '  async CancelAsync(id) {', '    return id;', '  }', '}'].join('\n');
  const found = extractSymbol(source, 'OrderService.CancelAsync(Guid id)')!;
  assert.match(found.text, /CancelAsync\(id\)/);
  assert.doesNotMatch(found.text, /class OrderService/, 'the method, not its whole class');
});

test('an indented Python def stops where the indentation returns', () => {
  const source = [
    'def outer():',
    '    pass',
    '',
    'def media(valores):',
    '    total = sum(valores)',
    '',
    '    return total / len(valores)',
    '',
    'def depois():',
    '    pass'
  ].join('\n');

  const found = extractSymbol(source, 'media')!;
  assert.match(found.text, /return total \/ len\(valores\)/, 'a blank line inside the body is not the end');
  assert.doesNotMatch(found.text, /def depois/);
  assert.doesNotMatch(found.text, /def outer/);
});

test('a one-line constant does not swallow the rest of the file', () => {
  const source = ['const LOCK_WAIT_MS = 15_000;', 'const OTHER = 1;', 'function f() {}'].join('\n');
  const found = extractSymbol(source, 'LOCK_WAIT_MS')!;
  assert.equal(found.text.trim(), 'const LOCK_WAIT_MS = 15_000;');
});

test('an unknown symbol returns nothing rather than a confident wrong slice', () => {
  const source = 'export function soma(a, b) { return a + b; }';
  assert.equal(extractSymbol(source, 'naoExiste'), undefined);
  assert.equal(extractSymbol(source, ''), undefined);
  // A word that only appears inside another identifier must not match.
  assert.equal(extractSymbol('const somatorio = 1;', 'soma'), undefined);
});

test('it holds up on this repository, which is what it exists for', async () => {
  const config = await readFile(new URL('../src/core/config.ts', import.meta.url), 'utf8');
  const defaults = extractSymbol(config, 'DEFAULT_CONFIG')!;
  assert.match(defaults.text, /projectName/, 'the field a 7B got wrong from the whole file');
  assert.match(defaults.text, /maxReviewRounds/);
  assert.ok(defaults.endLine - defaults.startLine < 25, 'a slice, not the file');

  const types = await readFile(new URL('../src/models/types.ts', import.meta.url), 'utf8');
  const shape = extractSymbol(types, 'ProjectConfig')!;
  assert.match(shape.text, /maxTaskAttempts/);
  assert.ok(shape.text.split('\n').length < types.split('\n').length / 2, 'much smaller than the file');
});

test('a body that opens and closes on one line stops there', () => {
  // The line ends in "}" rather than ";": the scan must not run into the next declaration.
  const source = ['export function alvo() { return 1; }', 'const outro = 2;', 'function depois() {}'].join('\n');
  const found = extractSymbol(source, 'alvo')!;
  assert.equal(found.text, 'export function alvo() { return 1; }');
  assert.equal(found.startLine, 1);
  assert.equal(found.endLine, 1);
});

test('a brace inside a string on the declaration line is not a body', () => {
  const source = ['const sep = "{";', 'const depois = 1;'].join('\n');
  assert.equal(extractSymbol(source, 'sep')!.text, 'const sep = "{";');
});

test('a C# body that opens on the next line comes back whole', () => {
  // With "{" on its own line (Allman style) the slice must still include the body.
  const source = [
    'public sealed class Clube',
    '{',
    '    public const int DenunciasParaOcultar = 3;',
    '',
    '    /// <summary>Publica um comentario.</summary>',
    '    public async Task<(Falha Falha, int? Id)> ComentarAsync(int clubeId, string? texto,',
    '        string? trecho = null, CancellationToken ct = default)',
    '    {',
    '        if (texto is null) return (Falha.Vazio, null);',
    '        var id = await SalvarAsync(texto, ct);',
    '        return (Falha.Nenhuma, id);',
    '    }',
    '',
    '    public static bool Vale(string? v) =>',
    '        v is not null;',
    '}'
  ].join('\n');

  const method = extractSymbol(source, 'ComentarAsync')!;
  assert.equal(method.startLine, 5, 'doc comment included');
  assert.equal(method.endLine, 12, 'through the closing brace of the body');
  assert.match(method.text, /return \(Falha\.Nenhuma, id\);/);

  const arrow = extractSymbol(source, 'Vale')!;
  assert.equal(arrow.endLine, 15, 'an expression body ends at its semicolon');
  assert.equal(extractSymbol(source, 'DenunciasParaOcultar')!.endLine, 3);
});

test('an enum with its brace on the next line keeps every member', () => {
  const source = ['public enum Estado', '{', '    NaFila = 0,', '    Traduzindo = 1,', '    Falhou = 7', '}', '', 'public class Depois {}'].join('\n');
  const found = extractSymbol(source, 'Estado')!;
  assert.equal(found.endLine, 6);
  assert.match(found.text, /Falhou = 7/);
  assert.doesNotMatch(found.text, /Depois/);
});

test('a C# declaration with its type before the name beats a line that only calls it', () => {
  const source = [
    'public class Contexto',
    '{',
    '    public override int SaveChanges()',
    '    {',
    '        var acervo = MexeNoAcervo();',
    '        return 1;',
    '    }',
    '',
    '    private bool MexeNoAcervo() => ChangeTracker.Entries().Any(e =>',
    '        e.State != EntityState.Unchanged);',
    '',
    '    public EscolaStatus Status { get; set; }',
    '}',
    '',
    'public enum EscolaStatus { Ativa, Suspensa }'
  ].join('\n');

  const method = extractSymbol(source, 'MexeNoAcervo')!;
  assert.equal(method.startLine, 9);
  assert.equal(method.endLine, 10);
  // A property typed EscolaStatus comes first, but the enum is what declares the name.
  assert.equal(extractSymbol(source, 'EscolaStatus')!.startLine, 15);
});

test('a name inside quotes or a regex brace does not fool the slice', () => {
  const source = [
    "  @Get('overview') overview() { return this.service.overview(); }",
    '',
    'function score(line: string): number {',
    '  if (/[{:=]\s*$/.test(line)) return 2;',
    '  return 0;',
    '}',
    'const after = 1;'
  ].join('\n');

  assert.equal(extractSymbol(source, 'overview')!.startLine, 1);
  const fn = extractSymbol(source, 'score')!;
  assert.equal(fn.endLine, 6, 'the "{" inside the regex is not an opening brace');
});

test('without semicolons a type ends where the next declaration begins', () => {
  const source = [
    'type First<T> = T extends [infer A, ...any[]] ? A : never',
    'type Second<T> = T extends [any, infer B] ? B : never',
    '',
    'export type State =',
    "  | { status: 'valid' }",
    "  | { status: 'expired' }",
    '',
    'const x = 1'
  ].join('\n');

  assert.equal(extractSymbol(source, 'First')!.endLine, 1);
  assert.equal(extractSymbol(source, 'State')!.endLine, 6, 'each union arm closes a brace, the type goes on');
});

test('a multi-line string is part of the body, blank lines and all', () => {
  const csharp = [
    'public static string Prompt(string alvo) => $"""',
    '    Traduza tudo para {alvo},',
    '',
    '    sem pular nada.',
    '    """;',
    'public static int Depois = 1;'
  ].join('\n');
  assert.equal(extractSymbol(csharp, 'Prompt')!.endLine, 5);

  const python = [
    'def criar_ass(linha):',
    '    cabecalho = r"""[Script Info]',
    'ScriptType: v4.00+',
    '"""',
    '    return cabecalho + linha',
    '',
    'def depois():',
    '    pass'
  ].join('\n');
  assert.equal(extractSymbol(python, 'criar_ass')!.endLine, 5);
});
