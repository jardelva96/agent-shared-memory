#!/usr/bin/env node
/** Test 4 -- finding code nobody pointed at. */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent } from './agente.mjs';
import { hasProvider } from './llm.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..');
const { codeFiles, findSymbol, outlineSymbols } = await import(pathToFileURL(path.join(repo, 'dist', 'core', 'symbols.js')).href);
const out = path.join(here, 'resultados', 'descoberta');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const MODELS = arg('models', 'gemini:gemini-3.1-flash-lite,gemini:gemini-3.5-flash-lite')
  .split(',')
  .map(spec => ({ provider: spec.split(':')[0], model: spec.split(':').slice(1).join(':') }));

const SYSTEM = [
  'You are a code-reading agent in an unfamiliar project. Find the code the question is about, read it, and answer.',
  'Never guess. When you have the answer, call the `answer` tool with it. Answer in Portuguese, briefly, with the exact',
  'numbers and names found in the code.'
].join('\n');

const DEFS = {
  search_text: {
    type: 'function',
    function: {
      name: 'search_text',
      description: 'Search the project for a text or regular expression. Returns up to 40 matching lines as file:line: text.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
    }
  },
  find_symbol: {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: 'Find where a function, class, method or constant is declared in the project. Returns "file::symbol" pointers.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    }
  },
  list_symbols: {
    type: 'function',
    function: {
      name: 'list_symbols',
      description: 'List what a file declares, with line ranges, without reading it.',
      parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
    }
  }
};

function toolsFor(root) {
  return {
    search_text: async ({ pattern }) => {
      let re;
      try {
        re = new RegExp(String(pattern ?? ''), 'i');
      } catch {
        re = new RegExp(String(pattern ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
      const found = [];
      for await (const file of codeFiles(root)) {
        const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n');
        for (let i = 0; i < lines.length && found.length < 40; i++) {
          if (re.test(lines[i])) found.push(`${path.relative(root, file).split(path.sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (found.length >= 40) break;
      }
      return found.length ? found.join('\n') : 'no matches';
    },
    search_text__def: DEFS.search_text,
    find_symbol: async ({ name }) => {
      const matches = await findSymbol(root, String(name ?? ''));
      return matches.length ? matches.map(m => `${m.pointer} (${m.kind}, lines ${m.declarationLine}-${m.endLine})`).join('\n') : 'not found';
    },
    find_symbol__def: DEFS.find_symbol,
    list_symbols: async ({ file }) => {
      const source = await readFile(path.resolve(root, String(file ?? '')), 'utf8');
      return outlineSymbols(source, String(file)).map(e => `${e.declarationLine}-${e.endLine} ${e.kind} ${e.container ? `${e.container}.` : ''}${e.name}`).join('\n');
    },
    list_symbols__def: DEFS.list_symbols
  };
}

async function loadQuestions() {
  const all = [];
  for (const f of ['perguntas.json', 'perguntas-locais.json'].map(f => path.join(here, f)).filter(existsSync)) all.push(...JSON.parse(await readFile(f, 'utf8')));
  return all.map(q => ({ ...q, root: path.isAbsolute(q.root) ? q.root : path.resolve(repo, q.root) }));
}

const grade = (q, answer) => {
  if (!answer) return { ok: false, score: 0 };
  const missed = q.expect.filter(p => !new RegExp(p, 'is').test(answer));
  return { ok: missed.length === 0, score: (q.expect.length - missed.length) / q.expect.length };
};

const questions = await loadQuestions();
await mkdir(out, { recursive: true });
const runsLog = path.join(out, 'runs.jsonl');
const done = new Set(existsSync(runsLog) ? (await readFile(runsLog, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.quota).map(r => r.key) : []);

await Promise.all(
  MODELS.filter(m => hasProvider(m.provider)).map(async m => {
    for (const q of questions) {
      for (const cond of questions.indexOf(q) % 2 ? ['texto', 'simbolo'] : ['simbolo', 'texto']) {
        const key = `${m.provider}/${m.model}|${q.id}|${cond}`;
        if (done.has(key)) continue;
        const names = cond === 'simbolo'
          ? ['find_symbol', 'list_symbols', 'read_pointer', 'search_text', 'read_file', 'list_files', 'answer']
          : ['search_text', 'read_file', 'list_files', 'answer'];
        const started = Date.now();
        const r = await runAgent({
          provider: m.provider,
          model: m.model,
          system: SYSTEM,
          user: `${q.question}\n\nThe project is the current folder; paths are relative to it.`,
          toolNames: names,
          root: q.root,
          extraTools: toolsFor(q.root),
          maxTurns: 12,
          meta: { exp: 'descoberta', key },
          log: path.join(out, 'chamadas.jsonl')
        });
        const g = grade(q, r.answer);
        const row = {
          key, provider: m.provider, model: m.model, q: q.id, lang: q.lang, cond, ok: g.ok, score: g.score, turns: r.turns,
          calls: r.totals.calls, prompt: r.totals.prompt, completion: r.totals.completion, total: r.totals.total,
          toolChars: r.totals.toolChars, wallMs: Date.now() - started, tools: r.toolCalls.map(t => t.name), error: r.error,
          quota: /daily quota/.test(r.error ?? ''), answer: r.answer
        };
        await appendFile(runsLog, `${JSON.stringify(row)}\n`, 'utf8');
        console.log(`${m.model.padEnd(28)} ${q.id.padEnd(16)} ${cond.padEnd(8)} ${g.ok ? 'CERTO ' : r.answer ? 'ERRADO' : 'FALHOU'} tok=${String(r.totals.total).padStart(7)} turnos=${r.turns}${r.error ? ` erro=${r.error.slice(0, 60)}` : ''}`);
        if (row.quota) return;
      }
    }
  })
);
console.log('fim');
