#!/usr/bin/env node
/**
 * How good is the symbol outline, measured against the compilers (no model involved).
 *
 *   cobertura -- of the declarations the compiler finds outside function bodies, how many
 *                the outline lists with the right name, line and end;
 *   precisao  -- of what the outline lists (of the kinds the compiler reports), how much is
 *                a real declaration on that line.
 *
 * A language server would get both right by construction; this is what the zero-install
 * heuristic gets, on real code.
 *
 * Usage: node --import tsx bench/outline.mjs <files.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { outlineSymbols } = await import(pathToFileURL(path.join(here, '..', 'src', 'core', 'symbols.ts')).href);
const files = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

const LANGS = {
  TypeScript: { test: f => /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.d\.ts$/.test(f), run: b => execFileSync(process.execPath, [path.join(here, 'recorte', 'ts-ref.mjs'), ...b], { maxBuffer: 1 << 28 }) },
  Python: { test: f => /\.py$/.test(f), run: b => execFileSync('py', ['-3.13', '-I', path.join(here, 'recorte', 'py_ref.py'), ...b], { maxBuffer: 1 << 28 }) },
  'C#': { test: f => /\.cs$/.test(f), run: b => execFileSync('dotnet', [path.join(here, 'recorte', 'cs-ref', 'bin', 'Release', 'net10.0', 'cs-ref.dll'), ...b], { maxBuffer: 1 << 28 }) }
};
// The kinds the outline reports that each compiler reference also reports, for precision.
const COMPARABLE = {
  TypeScript: null,
  Python: new Set(['class', 'function', 'method']),
  'C#': null
};

const result = {};
for (const [lang, spec] of Object.entries(LANGS)) {
  const list = files.filter(spec.test);
  if (!list.length) continue;
  const refs = [];
  for (let i = 0; i < list.length; i += 40) {
    refs.push(...spec.run(list.slice(i, i + 40)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  }
  const byFile = new Map();
  for (const r of refs) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r);

  let expected = 0, foundExact = 0, foundLine = 0, listed = 0, real = 0;
  for (const file of list) {
    const source = readFileSync(file, 'utf8');
    const outline = outlineSymbols(source, file);
    const rs = byFile.get(file) ?? [];
    const top = rs.filter(r => !r.nested && r.endLine - r.nameLine < 399);
    expected += top.length;
    for (const r of top) {
      const hit = outline.find(o => o.name === r.name && o.declarationLine === r.nameLine);
      if (hit) {
        foundLine++;
        if (hit.endLine === r.endLine) foundExact++;
      }
    }
    const comparable = COMPARABLE[lang];
    for (const o of outline.filter(o => !comparable || comparable.has(o.kind) || comparable.has(o.kind === 'record' || o.kind === 'struct' ? 'class' : o.kind))) {
      listed++;
      if (rs.some(r => r.name === o.name && r.nameLine === o.declarationLine)) real++;
    }
  }
  result[lang] = {
    arquivos: list.length,
    declaracoes: expected,
    cobertura: +(foundLine / expected).toFixed(4),
    cobertura_exata: +(foundExact / expected).toFixed(4),
    listados: listed,
    precisao: +(real / listed).toFixed(4)
  };
}
writeFileSync(path.join(here, 'resultados', 'outline.json'), JSON.stringify(result, null, 2));
console.table(result);
