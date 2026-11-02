#!/usr/bin/env node
/**
 * Test 1 -- does reading by pointer really save tokens, and does it cost correctness?
 *
 * Every question is asked twice per model, identically except for the tools:
 *   arquivo  -- read_file only: the agent reads whole files, as most agents do today;
 *   ponteiro -- read_pointer as well: the agent can ask for one symbol.
 * Both are told the same file and the same symbol, so the only difference is the tool.
 *
 * Token counts are the providers' own. Answers are graded against the facts in the code by
 * the patterns in the question files; every answer is kept so a person can check the grader.
 *
 * Re-running resumes: a run already in runs.jsonl is skipped, so a model whose daily quota
 * ran out can be finished the next day without repeating the others.
 *
 * Usage: BENCH_ENV_FILES="a/.env;b/.env" node bench/economia.mjs [--reps 2] [--only groq]
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runAgent } from './agente.mjs';
import { QuotaExhausted, hasProvider } from './llm.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..');
const out = path.join(here, 'resultados', 'economia');
const callsLog = path.join(out, 'chamadas.jsonl');
const runsLog = path.join(out, 'runs.jsonl');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const reps = Number(arg('reps', '2'));
const only = arg('only', '');

const GEMINI_SUBSET = ['ts-settlereview', 'cs-estado', 'cs-comentar', 'py-planejar'];

/** Gemini allows about 20 requests a day per model, so it answers a fixed subset once. */
const MODELS = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', reps },
  { provider: 'groq', model: 'openai/gpt-oss-20b', reps },
  { provider: 'groq', model: 'qwen/qwen3.8-27b', reps },
  { provider: 'openrouter', model: 'cohere/north-mini-code:free', reps },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free', reps },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', reps: 1 },
  { provider: 'openrouter', model: 'xingchen-agi/xing4.0-29b-a4b:free', reps: 1 },
  { provider: 'gemini', model: 'gemini-3.6-flash', reps: 1, subset: GEMINI_SUBSET },
  { provider: 'gemini', model: 'gemini-3.5-flash', reps: 1, subset: GEMINI_SUBSET },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite', reps: 1, subset: GEMINI_SUBSET },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite', reps: 1, subset: GEMINI_SUBSET }
];

const SYSTEM = [
  'You are a code-reading agent. Use the tools to read the code before answering; never guess.',
  'When you have the answer, call the `answer` tool with it. Answer in Portuguese, briefly,',
  'with the exact numbers and names found in the code.'
].join('\n');

async function loadQuestions() {
  const files = ['perguntas.json', 'perguntas-locais.json'].map(f => path.join(here, f)).filter(existsSync);
  const all = [];
  for (const file of files) all.push(...JSON.parse(await readFile(file, 'utf8')));
  return all.map(q => ({ ...q, root: path.isAbsolute(q.root) ? q.root : path.resolve(repo, q.root) }));
}

function userMessage(q, cond) {
  if (cond === 'ponteiro') return `${q.question}\n\nPONTEIRO(S): ${q.pointers.join(' ; ')}`;
  const files = [...new Set(q.pointers.map(p => p.split('::')[0]))];
  const symbols = q.pointers.map(p => p.split('::')[1]);
  return `${q.question}\n\nO codigo esta em: ${files.join(' ; ')} (simbolos: ${symbols.join(', ')}).`;
}

function grade(q, answer) {
  if (!answer) return { score: 0, ok: false, missed: q.expect };
  const missed = q.expect.filter(pattern => !new RegExp(pattern, 'is').test(answer));
  return { score: (q.expect.length - missed.length) / q.expect.length, ok: missed.length === 0, missed };
}

async function doneKeys() {
  if (!existsSync(runsLog)) return new Set();
  const lines = (await readFile(runsLog, 'utf8')).split('\n').filter(Boolean);
  // A run that died on a daily quota did not measure anything; it runs again next time.
  return new Set(lines.map(l => JSON.parse(l)).filter(r => !r.quota).map(r => r.key));
}

const questions = await loadQuestions();
const finished = await doneKeys();
await mkdir(out, { recursive: true });

const plan = MODELS.filter(m => (!only || m.provider === only) && hasProvider(m.provider));
console.log(`perguntas=${questions.length} modelos=${plan.length} saida=${out}`);

await Promise.all(
  plan.map(async m => {
    const qs = questions.filter(q => !m.subset || m.subset.includes(q.id));
    let stop = false;
    for (let rep = 1; rep <= m.reps && !stop; rep++) {
      for (const q of qs) {
        // Alternate which condition goes first, so neither always gets the warmer minute.
        const order = (rep + qs.indexOf(q)) % 2 ? ['arquivo', 'ponteiro'] : ['ponteiro', 'arquivo'];
        for (const cond of order) {
          const key = `${m.provider}/${m.model}|${q.id}|${cond}|${rep}`;
          if (finished.has(key)) continue;
          if (stop) break;
          const tools = cond === 'ponteiro' ? ['read_pointer', 'read_file', 'list_files', 'answer'] : ['read_file', 'list_files', 'answer'];
          const started = Date.now();
          const r = await runAgent({
            provider: m.provider,
            model: m.model,
            system: SYSTEM,
            user: userMessage(q, cond),
            toolNames: tools,
            root: q.root,
            meta: { exp: 'economia', key },
            log: callsLog
          });
          const quota = /daily quota/.test(r.error ?? '');
          const g = grade(q, r.answer);
          const row = {
            key,
            ts: new Date().toISOString(),
            provider: m.provider,
            model: m.model,
            q: q.id,
            lang: q.lang,
            cond,
            rep,
            ok: g.ok,
            score: g.score,
            missed: g.missed,
            turns: r.turns,
            calls: r.totals.calls,
            prompt: r.totals.prompt,
            completion: r.totals.completion,
            total: r.totals.total,
            reasoning: r.totals.reasoning,
            missingUsage: r.totals.missingUsage,
            toolChars: r.totals.toolChars,
            apiMs: r.totals.ms,
            wallMs: Date.now() - started,
            tools: r.toolCalls,
            usedReadFile: r.toolCalls.some(t => t.name === 'read_file'),
            error: r.error,
            quota,
            answer: r.answer
          };
          await appendFile(runsLog, `${JSON.stringify(row)}\n`, 'utf8');
          console.log(
            `${m.model.padEnd(36)} ${q.id.padEnd(16)} ${cond.padEnd(8)} r${rep} ` +
              `${g.ok ? 'CERTO ' : r.answer ? 'ERRADO' : 'FALHOU'} tok=${String(r.totals.total).padStart(7)} turnos=${r.turns}` +
              (r.error ? ` erro=${r.error.slice(0, 70)}` : '')
          );
          if (quota) {
            console.log(`${m.model}: cota do dia acabou; continua amanha`);
            stop = true;
          }
        }
      }
    }
  })
);
console.log('fim');
