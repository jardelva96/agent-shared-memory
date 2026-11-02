#!/usr/bin/env node
/**
 * Test 0 -- does a pointer bring back the right code? No model involved.
 *
 * For every declaration the language's own compiler finds (TypeScript, Python's ast,
 * Roslyn for C#), extractSymbol is asked for it by name and its slice is compared with the
 * compiler's span:
 *   exato    -- the right declaration, ending on the right line;
 *   cortado  -- the right declaration, ending too early (the agent misses part of it);
 *   passou   -- the right declaration, running into what follows;
 *   errado   -- a different piece of code (the worst case: confident and wrong);
 *   nao_achou-- nothing returned (the agent falls back to reading the file).
 * Names declared more than once in a file are counted apart: a pointer by bare name cannot
 * tell them apart, and charging that to the extractor would blur what is being measured.
 *
 * Usage: node --import tsx bench/recorte.mjs <old-extract.ts> <files.txt>
 *   files.txt lists one source path per line.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const [oldPath, listPath] = process.argv.slice(2);
const { extractSymbol: depois } = await import(pathToFileURL(path.join(here, '..', 'src', 'core', 'extract.ts')).href);
const { extractSymbol: antes } = await import(pathToFileURL(path.resolve(oldPath)).href);

const files = readFileSync(listPath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const byLang = { TypeScript: [], Python: [], 'C#': [] };
for (const f of files) {
  if (/\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.d\.ts$/.test(f)) byLang.TypeScript.push(f);
  else if (/\.py$/.test(f)) byLang.Python.push(f);
  else if (/\.cs$/.test(f)) byLang['C#'].push(f);
}

function references(lang, batch) {
  const run = {
    TypeScript: () => execFileSync(process.execPath, [path.join(here, 'recorte', 'ts-ref.mjs'), ...batch], { maxBuffer: 1 << 28 }),
    Python: () => execFileSync('py', ['-3.13', '-I', path.join(here, 'recorte', 'py_ref.py'), ...batch], { maxBuffer: 1 << 28 }),
    'C#': () => execFileSync('dotnet', [path.join(here, 'recorte', 'cs-ref', 'bin', 'Release', 'net10.0', 'cs-ref.dll'), ...batch], { maxBuffer: 1 << 28 })
  }[lang];
  return run().toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const qualified = ref => (ref.container ? `${ref.container}.${ref.name}` : ref.name);
const COMMENTISH = /^\s*(\/\/|\/\*|\*|#|\[|@|$)/;

function classify(extract, source, lines, ref) {
  // A member is pointed at through its type (`TaskStore.claim`), as a person would write it.
  const slice = extract(source, qualified(ref));
  if (!slice) return 'nao_achou';
  // Right declaration: the slice starts at it, or only comments/attributes/decorators sit
  // between the slice's first line and the line naming it.
  if (ref.nameLine < slice.startLine || ref.nameLine > slice.endLine) return 'errado';
  for (let i = slice.startLine; i < ref.nameLine; i++) {
    if (!COMMENTISH.test(lines[i - 1])) return 'errado';
  }
  if (slice.endLine === ref.endLine) return 'exato';
  return slice.endLine < ref.endLine ? 'cortado' : 'passou';
}

const KINDS = ['exato', 'cortado', 'passou', 'errado', 'nao_achou'];
const result = {};
const examples = {};

for (const [lang, list] of Object.entries(byLang)) {
  if (!list.length) continue;
  const refs = [];
  for (let i = 0; i < list.length; i += 40) refs.push(...references(lang, list.slice(i, i + 40)));

  const stats = { arquivos: list.length, declaracoes: refs.length, repetidos: 0, longos: 0, antes: {}, depois: {}, porTipo: {} };
  for (const k of KINDS) stats.antes[k] = stats.depois[k] = 0;
  examples[lang] = [];

  const byFile = new Map();
  for (const r of refs) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, rs] of byFile) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const count = new Map();
    for (const r of rs) count.set(qualified(r), (count.get(qualified(r)) ?? 0) + 1);
    for (const r of rs) {
      // A field of an anonymous type (`rows: Array<{ agent: string }>`) has no name anyone
      // could point at; it is not a symbol of the file.
      if (/Signature|PropertyDeclaration|Accessor|Constructor|MethodDeclaration/.test(r.kind) && lang === 'TypeScript' && !r.container) continue;
      if (count.get(qualified(r)) > 1) {
        stats.repetidos++;
        continue;
      }
      // The extractor caps a slice at 400 lines by design; that is a limit, not a miss.
      if (r.endLine - r.nameLine >= 399) {
        stats.longos++;
        continue;
      }
      const a = classify(antes, source, lines, r);
      const d = classify(depois, source, lines, r);
      stats.antes[a]++;
      stats.depois[d]++;
      const t = (stats.porTipo[r.kind] ??= { n: 0, antesExato: 0, depoisExato: 0, depois: {} });
      t.n++;
      if (a === 'exato') t.antesExato++;
      if (d === 'exato') t.depoisExato++;
      t.depois[d] = (t.depois[d] ?? 0) + 1;
      if (d !== 'exato' && examples[lang].length < 40) {
        const s = depois(source, qualified(r));
        examples[lang].push({ file, name: r.name, kind: r.kind, ref: [r.nameLine, r.endLine], slice: s ? [s.startLine, s.endLine] : null, depois: d, antes: a });
      }
    }
  }
  result[lang] = stats;
}

const outDir = path.join(here, 'resultados');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'recorte.json'), JSON.stringify({ result, examples }, null, 2));

const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : '-');
for (const [lang, s] of Object.entries(result)) {
  const total = KINDS.reduce((sum, k) => sum + s.depois[k], 0);
  console.log(`\n== ${lang}: ${s.arquivos} arquivos, ${s.declaracoes} declaracoes, ${total} medidas (${s.repetidos} nomes repetidos, ${s.longos} com mais de 400 linhas fora)`);
  for (const k of KINDS) console.log(`  ${k.padEnd(10)} antes ${pct(s.antes[k], total).padStart(6)}   depois ${pct(s.depois[k], total).padStart(6)}`);
  for (const [kind, t] of Object.entries(s.porTipo).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${kind.padEnd(28)} n=${String(t.n).padStart(5)} exato antes ${pct(t.antesExato, t.n).padStart(6)} depois ${pct(t.depoisExato, t.n).padStart(6)}`);
  }
}
