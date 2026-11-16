import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editSymbol, findReferences, findSymbol, outlineSymbols, renameSymbol, scanBudget } from '../src/core/symbols.js';
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
  // Two agents rewriting the whole file from an old read: the second write erases the first.
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

test('an edit that breaks the syntax is refused with the line, and nothing is written', async () => {
  // A regex without its closing slash.
  const broken = 'export function contarPalavras(texto) {\n  const re = /\p{L}+gu;\n  return 0;\n}';
  await withProject(
    {
      'src/texto.js': TEXTO,
      'src/a.ts': 'export function a(): number {\n  return 1;\n}\n',
      'src/a.py': 'def a():\n    return 1\n',
      'src/A.cs': 'public class A\n{\n    public int B() { return 1; }\n}\n'
    },
    async root => {
      await assert.rejects(editSymbol(root, 'src/texto.js::contarPalavras', broken), /Not written: this change breaks the syntax of src\/texto\.js at line \d/);
      assert.equal(await readFile(path.join(root, 'src/texto.js'), 'utf8'), TEXTO, 'untouched');

      await assert.rejects(editSymbol(root, 'src/a.ts::a', 'export function a(): number {\n  return (1;\n}'), /breaks the syntax of src\/a\.ts/);
      await assert.rejects(editSymbol(root, 'src/a.py::a', 'def a(:\n    return 1'), /breaks the syntax of src\/a\.py/);
      await assert.rejects(editSymbol(root, 'src/A.cs::A.B', 'public int B() { return 1; '), /breaks the syntax of src\/A\.cs/);

      // A correct change still goes through, in every language.
      await editSymbol(root, 'src/a.py::a', 'def a():\n    return 2');
      await editSymbol(root, 'src/A.cs::A.B', 'public int B() { return 2; }');
      assert.match(await readFile(path.join(root, 'src/A.cs'), 'utf8'), /return 2;/);
    }
  );
});

test('a file that was already broken can still be edited, since the edit may be the fix', async () => {
  await withProject({ 'src/m.js': 'export function a() {\n  return (1;\n}\n' }, async root => {
    await editSymbol(root, 'src/m.js::a', 'export function a() {\n  return 1;\n}');
    assert.match(await readFile(path.join(root, 'src/m.js'), 'utf8'), /return 1;/);
  });
});

test('rename shows the plan first, changes only code, and refuses an ambiguous name', async () => {
  await withProject(
    {
      'src/a.ts': 'export function calcTotal(a: number) {\n  return a;\n}\n',
      'src/b.ts': "import { calcTotal } from './a';\n// calcTotal em comentario\nexport const x = calcTotal(1);\nconst s = 'calcTotal';\n",
      'src/c.ts': 'export function load() {}\n',
      'src/d.ts': 'export function load() {}\n'
    },
    async root => {
      const plan = await renameSymbol(root, 'calcTotal', 'somarTotal');
      assert.equal(plan.applied, false);
      assert.deepEqual(plan.changes.map(c => `${c.file}:${c.line}`), ['src/a.ts:1', 'src/b.ts:1', 'src/b.ts:3']);
      assert.match(await readFile(path.join(root, 'src/b.ts'), 'utf8'), /calcTotal\(1\)/, 'nothing written yet');

      await renameSymbol(root, 'calcTotal', 'somarTotal', { apply: true });
      const b = await readFile(path.join(root, 'src/b.ts'), 'utf8');
      assert.match(b, /import \{ somarTotal \}/);
      assert.match(b, /\/\/ calcTotal em comentario/, 'comments keep the old word');
      assert.match(b, /'calcTotal'/, 'strings keep it too');

      assert.match((await renameSymbol(root, 'load', 'carregar')).refused!, /declared 2 times/);
      assert.match((await renameSymbol(root, 'somarTotal', 'load')).refused!, /already declared/);
    }
  );
});

test('rename changes the whole word only, never part of a longer name', async () => {
  await withProject(
    {
      'src/m.ts': 'export function total(a: number) {\n  return a;\n}\nconst subtotal = 1;\nconst x = total(subtotal) + subtotal + totals();\nfunction totals() { return 0; }\n'
    },
    async root => {
      await renameSymbol(root, 'total', 'sum', { apply: true });
      const m = await readFile(path.join(root, 'src/m.ts'), 'utf8');
      assert.match(m, /function sum\(a/);
      assert.match(m, /const x = sum\(subtotal\) \+ subtotal \+ totals\(\)/);
      assert.doesNotMatch(m, /subsum|sums/);
    }
  );
});

/** A C# class of `count` five-line methods: 100 of them run past the 400-line read limit. */
function longClass(count: number): string {
  const methods = Array.from({ length: count }, (_, i) => [`    public int M${i}()`, '    {', `        return ${i};`, '    }', ''].join('\n'));
  return ['namespace Loja', '{', '    public class Grande', '    {', ...methods, '    }', '}', ''].join('\n');
}

test('a type longer than the read limit is listed with its real end', () => {
  // Seen on a 1,863-line C# service: the class was listed as lines 20-419, its methods up to 1,133.
  const outline = outlineSymbols(longClass(100), 'Grande.cs');
  assert.equal(outline.find(e => e.name === 'Grande')!.endLine, 505);
  assert.equal(outline.find(e => e.name === 'M99')!.endLine, 503);
});

test('inserting after a type longer than the read limit puts the code after it, not inside it', async () => {
  await withProject({ 'src/Grande.cs': longClass(100) }, async root => {
    await editSymbol(root, 'src/Grande.cs::Grande', 'public class Depois\n{\n}', 'insert_after');
    const lines = (await readFile(path.join(root, 'src/Grande.cs'), 'utf8')).split('\n');
    assert.equal(lines[504], '    }', 'Grande still closes where it did');
    assert.equal(lines.indexOf('    public class Depois'), 506, 'the new type comes after it, past one blank line');
  });
});

test('replacing a method longer than the read limit replaces all of it', async () => {
  const body = Array.from({ length: 450 }, (_, i) => `        var v${i} = ${i};`);
  const source = ['public class Caixa', '{', '    public int Soma()', '    {', ...body, '        return 0;', '    }', '', '    public int Outro() { return 1; }', '}', ''].join('\n');
  await withProject({ 'src/Caixa.cs': source }, async root => {
    const result = await editSymbol(root, 'src/Caixa.cs::Caixa.Soma', 'public int Soma()\n{\n    return 1;\n}');
    assert.equal(result.removedLines, 454);
    const after = await readFile(path.join(root, 'src/Caixa.cs'), 'utf8');
    assert.equal(after, ['public class Caixa', '{', '    public int Soma()', '    {', '        return 1;', '    }', '', '    public int Outro() { return 1; }', '}', ''].join('\n'));
  });
});

// Legacy C# saved as Windows-1252: "ç", "ã" and "é" are one byte each, and not valid UTF-8.
const PEDIDO_1252 = [
  'public class Pedido',
  '{',
  '    // Atenção: cálculo do preço',
  '    public string Situacao() { return "Não pago"; }',
  '',
  '    public int Total()',
  '    {',
  '        return 0;',
  '    }',
  '}',
  ''
].join('\r\n');

test('a Windows-1252 file is edited in Windows-1252, and every byte the edit did not change stays', async () => {
  await withProject({}, async root => {
    const file = path.join(root, 'Pedido.cs');
    await writeFile(file, Buffer.from(PEDIDO_1252, 'latin1'));
    const result = await editSymbol(root, 'Pedido.cs::Pedido.Total', 'public int Total()\n{\n    return 42; // preço em €\n}');
    assert.equal(result.encoding, 'windows-1252');
    // € is byte 0x80 in Windows-1252.
    const expected = PEDIDO_1252.replace('        return 0;', '        return 42; // preço em \x80');
    assert.deepEqual(await readFile(file), Buffer.from(expected, 'latin1'), 'read as UTF-8, the accents of line 3 came back as U+FFFD');
  });
});

test('new text that Windows-1252 cannot hold is refused, and the file is left as it was', async () => {
  await withProject({}, async root => {
    const file = path.join(root, 'Pedido.cs');
    await writeFile(file, Buffer.from(PEDIDO_1252, 'latin1'));
    await assert.rejects(
      editSymbol(root, 'Pedido.cs::Pedido.Total', 'public int Total()\n{\n    return 0; // a → b\n}'),
      /"→" \(U\+2192\) on line 8 of the new text has no byte in Windows-1252/
    );
    assert.deepEqual(await readFile(file), Buffer.from(PEDIDO_1252, 'latin1'));
  });
});

test('a rename keeps a Windows-1252 file in Windows-1252', async () => {
  await withProject({}, async root => {
    await writeFile(path.join(root, 'Pedido.cs'), Buffer.from(PEDIDO_1252, 'latin1'));
    await writeFile(path.join(root, 'Uso.cs'), Buffer.from('// situação\r\nvar s = new Pedido().Situacao();\r\n', 'latin1'));
    await renameSymbol(root, 'Situacao', 'Estado', { apply: true });
    assert.deepEqual(await readFile(path.join(root, 'Pedido.cs')), Buffer.from(PEDIDO_1252.replace('Situacao', 'Estado'), 'latin1'));
    assert.deepEqual(await readFile(path.join(root, 'Uso.cs')), Buffer.from('// situação\r\nvar s = new Pedido().Estado();\r\n', 'latin1'));
  });
});

test('a UTF-8 file keeps its BOM through an edit', async () => {
  await withProject({}, async root => {
    const file = path.join(root, 'A.cs');
    await writeFile(file, '﻿public class A\n{\n    public int B() { return 1; }\n}\n', 'utf8');
    const result = await editSymbol(root, 'A.cs::A.B', 'public int B() { return 2; }');
    assert.equal(result.encoding, 'utf8');
    assert.equal(await readFile(file, 'utf8'), '﻿public class A\n{\n    public int B() { return 2; }\n}\n');
  });
});

test('a search that stops at the file limit says so, and a rename then refuses to start', async () => {
  // Seen on a 52,000-file codebase: past the limit, find answered "not found" for code that was there.
  await withProject({ 'src/a.ts': 'export function alvo() {}\n', 'src/b.ts': 'alvo();\n', 'src/c.ts': 'alvo();\n' }, async root => {
    const whole = scanBudget(3);
    assert.equal((await findReferences(root, 'alvo', 100, whole)).length, 2);
    assert.ok(!whole.skipped, 'three files fit a limit of three');

    const cut = scanBudget(2);
    assert.deepEqual((await findReferences(root, 'alvo', 100, cut)).map(r => r.file), ['src/b.ts']);
    assert.equal(cut.skipped, true);

    const plan = await renameSymbol(root, 'alvo', 'outro', { apply: true, maxFiles: 2 });
    assert.match(plan.refused!, /more than 2 code files/);
    assert.equal(plan.applied, false);
    assert.equal(await readFile(path.join(root, 'src/c.ts'), 'utf8'), 'alvo();\n', 'a rename that misses uses breaks the build');
    assert.equal(await readFile(path.join(root, 'src/a.ts'), 'utf8'), 'export function alvo() {}\n');
  });
});
