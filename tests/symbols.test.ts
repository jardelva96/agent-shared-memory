import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editSymbol, findReferences, findSymbol, outlineSymbols } from '../src/core/symbols.js';
import { extractSymbol } from '../src/core/extract.js';

async function withProject(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-sym-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text, 'utf8');
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const TEXTO = [
  "export function quebrarLinhas(texto, largura) {",
  "  throw new Error('nao implementado');",
  "}",
  "",
  "export function contarPalavras(texto) {",
  "  throw new Error('nao implementado');",
  "}",
  ""
].join('\n');

test('the outline lists what a file declares, members with their type, not what bodies declare', () => {
  const source = [
    'export const LIMITE = 3;',
    '',
    'export class Fila {',
    '  private itens: string[] = [];',
    '  constructor(private readonly nome: string) {}',
    '  async init(): Promise<void> {',
    '    const interno = 1;',
    '  }',
    '  remove(id: string) {',
    '    return id;',
    '  }',
    '}',
    '',
    'export function solta() {',
    '  function aninhada() {}',
    '}'
  ].join('\n');
  const names = outlineSymbols(source, 'fila.ts').map(e => `${e.container ? `${e.container}.` : ''}${e.name}:${e.kind}`);
  assert.deepEqual(names, ['LIMITE:const', 'Fila:class', 'Fila.itens:property', 'Fila.constructor:method', 'Fila.init:method', 'Fila.remove:method', 'solta:function']);
});

test('the C# outline reads typed members, tuples and expression bodies', () => {
  const source = [
    'namespace Loja;',
    '',
    'public sealed class Pedidos(Db db)',
    '{',
    '    private static readonly Dictionary<string, (int Qtd, decimal Preco)> Cache = new();',
    '    public string Rotulo => $"pedido {Id}";',
    '    public int Id { get; init; }',
    '    public async Task<(bool Ok, string? Erro)> FecharAsync(int id, CancellationToken ct = default)',
    '    {',
    '        var conversor = new Conversor(',
    '            v => v.ToUpper(),',
    '            v => v);',
    '        return (true, null);',
    '    }',
    '}'
  ].join('\n');
  const names = outlineSymbols(source, 'Pedidos.cs').map(e => `${e.name}@${e.declarationLine}`);
  assert.deepEqual(names, ['Pedidos@3', 'Cache@5', 'Rotulo@6', 'Id@7', 'FecharAsync@8']);
});

test('the Python outline keeps methods of classes and leaves nested functions out', () => {
  const source = ['RAIZ = 1', 'CONFIG = 2', '', 'class Linha:', '    def __init__(self):', '        def interna():', '            pass', '', 'def solta():', '    """Doc com def falsa:', 'def nada():', '    """', '    return 1'].join('\n');
  const found = outlineSymbols(source, 'x.py').map(e => `${e.name}:${e.startLine}-${e.endLine}`);
  assert.deepEqual(found, ['RAIZ:1-1', 'CONFIG:2-2', 'Linha:4-7', '__init__:5-7', 'solta:9-13']);
});

test('a qualified pointer finds the member inside its own type, not a local of the same name', () => {
  const source = [
    'export class Servico {',
    '  async executar() {',
    '    const config = { a: 1 };',
    '    return config;',
    '  }',
    '  async config(): Promise<number> {',
    '    return 1;',
    '  }',
    '}'
  ].join('\n');
  assert.equal(extractSymbol(source, 'Servico.config')!.declarationLine, 6);
});

test('find and references search the project, skipping dependencies', async () => {
  await withProject(
    {
      'src/a.ts': 'export function alvo() { return 1; }\n',
      'src/b.ts': "import { alvo } from './a';\nconst x = alvo();\n// alvo em comentario\nconst s = 'alvo';\n",
      'node_modules/pkg/index.ts': 'export function alvo() {}\n'
    },
    async root => {
      const found = await findSymbol(root, 'alvo');
      assert.deepEqual(found.map(f => f.pointer), ['src/a.ts::alvo']);
      const refs = await findReferences(root, 'alvo');
      assert.deepEqual(refs.map(r => `${r.file}:${r.line}`), ['src/b.ts:1', 'src/b.ts:2'], 'not the comment, the string or node_modules');
    }
  );
});

test('replacing a symbol changes only its lines and keeps the indentation', async () => {
  const source = ['export class Caixa {', '  /** Soma. */', '  somar(a: number) {', '    return 0;', '  }', '', '  outro() {}', '}', ''].join('\n');
  await withProject({ 'src/caixa.ts': source }, async root => {
    const result = await editSymbol(root, 'src/caixa.ts::Caixa.somar', 'somar(a: number) {\n  return a + 1;\n}');
    assert.equal(result.removedLines, 3);
    const after = await readFile(path.join(root, 'src/caixa.ts'), 'utf8');
    assert.equal(after, ['export class Caixa {', '  /** Soma. */', '  somar(a: number) {', '    return a + 1;', '  }', '', '  outro() {}', '}', ''].join('\n'));
  });
});

test('two agents editing two functions of one file at the same time both keep their work', async () => {
  // The race measured with real agents: each rewrote the whole file from its own earlier
  // read, and the second write erased the first. By symbol, the file is re-read under a lock.
  await withProject({ 'src/texto.js': TEXTO }, async root => {
    await Promise.all([
      editSymbol(root, 'src/texto.js::quebrarLinhas', 'export function quebrarLinhas(texto, largura) {\n  return [texto];\n}'),
      editSymbol(root, 'src/texto.js::contarPalavras', 'export function contarPalavras(texto) {\n  return texto.split(" ").length;\n}')
    ]);
    const after = await readFile(path.join(root, 'src/texto.js'), 'utf8');
    assert.match(after, /return \[texto\];/);
    assert.match(after, /return texto\.split/);
    assert.doesNotMatch(after, /nao implementado/);
  });
});

test('inserting after a symbol adds a new one, and CRLF files stay CRLF', async () => {
  await withProject({ 'src/m.ts': 'export function a() {\r\n  return 1;\r\n}\r\n' }, async root => {
    await editSymbol(root, 'src/m.ts::a', 'export function b() {\n  return 2;\n}', 'insert_after');
    const after = await readFile(path.join(root, 'src/m.ts'), 'utf8');
    assert.equal(after, 'export function a() {\r\n  return 1;\r\n}\r\n\r\nexport function b() {\r\n  return 2;\r\n}\r\n');
  });
});

test('an edit refuses a pointer outside the project or a symbol that is not there', async () => {
  await withProject({ 'src/m.ts': 'export const x = 1;\n' }, async root => {
    await assert.rejects(editSymbol(root, '../fora.ts::x', 'x'), /Outside the project/);
    await assert.rejects(editSymbol(root, 'src/m.ts::naoExiste', 'x'), /was not found/);
    await assert.rejects(editSymbol(root, 'src/m.ts', 'x'), /Not a symbol pointer/);
  });
});
