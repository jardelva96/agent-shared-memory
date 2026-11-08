import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module the CLI loads before it runs a command: its static imports, followed through the source. */
function staticImports(entry: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (found.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1]);
    found.set(file, specifiers);
    for (const s of specifiers) {
      if (s.startsWith('.')) pending.push(path.resolve(path.dirname(file), s.replace(/\.js$/, '.ts')));
    }
  }
  return found;
}

test('a hook call does not load child_process, crypto or util until it needs them', () => {
  const offenders: string[] = [];
  for (const [file, specifiers] of staticImports(path.join(SRC, 'cli', 'main.ts'))) {
    for (const s of specifiers) {
      if (/^node:(child_process|crypto|util)$/.test(s)) offenders.push(`${path.relative(SRC, file).split(path.sep).join('/')}: ${s}`);
    }
  }
  // Each one costs every hook call 1 to 3 ms on Windows, and most calls never run git or make an id.
  assert.deepEqual(offenders, []);
});
