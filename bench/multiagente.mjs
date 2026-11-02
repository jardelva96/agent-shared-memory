#!/usr/bin/env node
/**
 * Tests 2 and 3 -- several agents from different providers on one repository, through the real
 * queue (`agent-memory run`), with the result graded by tests the agents never see.
 */
import { readFile, readdir, writeFile, mkdir, cp, appendFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'dist', 'cli', 'main.js');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const conds = arg('conds', 'sem_memoria,solo,revisao').split(',');
const minutes = Number(arg('minutes', '60'));

const ALL_AGENTS = [
  { id: 'GPTOSS', provider: 'groq', model: 'openai/gpt-oss-120b' },
  { id: 'QWEN', provider: 'groq', model: 'qwen/qwen3.8-27b' },
  { id: 'NEMOTRON', provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free' },
  { id: 'NORTH', provider: 'openrouter', model: 'cohere/north-mini-code:free' },
  { id: 'LIGHTNING', provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' }
];
const pick = arg('agents', '');
const AGENTS = pick ? ALL_AGENTS.filter(a => pick.split(',').includes(a.id)) : ALL_AGENTS;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = path.join(here, 'resultados', arg('out', 'multiagente'), stamp);
const only = arg('only', '');
const tarefas = JSON.parse(await readFile(path.join(here, 'tarefas', 'tarefas.json'), 'utf8')).filter(t => !only || only.split(',').includes(t.id));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function memory(root, ...args) {
  return execFileSync(process.execPath, [cli, '--root', root, ...args], { encoding: 'utf8' });
}

async function prepare(cond) {
  const dir = path.join(base, cond);
  const root = path.join(dir, 'projeto');
  await mkdir(dir, { recursive: true });
  await cp(path.join(here, 'tarefas', 'modelo'), root, { recursive: true });
  memory(root, 'init', '--name', `loja-mini (${cond})`);
  memory(root, 'register', '--agent', 'LEAD', '--role', 'quem cria as tarefas');
  for (const a of AGENTS) memory(root, 'register', '--agent', a.id, '--role', a.model);

  const ids = {};
  for (const t of tarefas) {
    const args = ['task', 'create', '--agent', 'LEAD', '--title', `[${t.id}] ${t.title}`, '--detail', t.spec, '--pointer', `${t.file}::${t.symbol}`, '--json'];
    if (cond === 'revisao' || cond.endsWith('_revisao')) args.push('--review');
    if (t.dependsOn) args.push('--depends-on', t.dependsOn.map(d => ids[d]).join(','));
    ids[t.id] = JSON.parse(memory(root, ...args)).id;
  }
  return { cond, dir, root, ids, runners: [], stopped: new Set() };
}

function startRunners(run) {
  for (const a of AGENTS) {
    const log = createWriteStream(path.join(run.dir, `${a.id}.log`));
    const child = spawn(
      process.execPath,
      [cli, '--root', run.root, 'run', '--agent', a.id, '--exec', `node ${path.join(here, 'executor.mjs').replace(/\\/g, '/')}`, '--interval', '2'],
      {
        env: {
          ...process.env,
          BENCH_PROVIDER: a.provider,
          BENCH_MODEL: a.model,
          BENCH_COND: run.cond,
          BENCH_LOG: path.join(run.dir, 'chamadas.jsonl'),
          BENCH_RUNS: path.join(run.dir, 'execucoes.jsonl'),
          BENCH_QUOTA_DIR: run.dir
        },
        windowsHide: true
      }
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    run.runners.push({ agent: a.id, child });
  }
}

function kill(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

async function tasksOf(root) {
  const dir = path.join(root, '.agents', 'tasks');
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  return Promise.all(files.map(async f => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}

async function watch(run, deadline) {
  while (Date.now() < deadline) {
    await sleep(5000);
    for (const r of run.runners) {
      if (!run.stopped.has(r.agent) && existsSync(path.join(run.dir, `${r.agent}.quota`))) {
        run.stopped.add(r.agent);
        kill(r.child);
        await appendFile(path.join(run.dir, 'eventos.log'), `${new Date().toISOString()} ${r.agent} parou: cota do dia\n`);
      }
    }
    const tasks = await tasksOf(run.root);
    const pending = tasks.filter(t => t.status === 'OPEN' || t.status === 'CLAIMED');
    if (pending.length === 0) return 'terminou';
    if (run.runners.every(r => r.child.exitCode !== null || run.stopped.has(r.agent))) return 'agentes pararam';
  }
  return 'tempo esgotado';
}

function hidden(root, id) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--test', path.join(here, 'tarefas', 'ocultos', `${id}.test.js`)], { env: { ...process.env, PROJETO: root.replace(/\\/g, '/') }, timeout: 60_000 }, (_e, out, err) => {
      const text = `${out}\n${err}`;
      const n = name => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
      resolve({ tests: n('tests'), pass: n('pass') });
    });
  });
}

async function evaluate(run, why) {
  const tasks = await tasksOf(run.root);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const runs = existsSync(path.join(run.dir, 'execucoes.jsonl'))
    ? (await readFile(path.join(run.dir, 'execucoes.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

  const porTarefa = {};
  for (const t of tarefas) {
    const id = run.ids[t.id];
    const work = byId.get(id);
    const h = await hidden(run.root, t.id);
    const mine = runs.filter(r => r.work === id);
    // Delivered, yet the function is back to the stub: another agent wrote over it.
    const finalSource = await readFile(path.join(run.root, t.file), 'utf8').catch(() => '');
    const body = finalSource.split(/\n(?=export )/).find(part => new RegExp(`\\b${t.symbol}\\b`).test(part.split('\n')[0])) ?? '';
    const apagado = mine.some(r => !r.review && r.wrote) && /nao implementado/.test(body);
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] ?? 0), 0);
    porTarefa[t.id] = {
      status: work?.status,
      rodadasDeRevisao: work?.reviewRounds ?? 0,
      ocultos: `${h.pass}/${h.tests}`,
      ocultosPass: h.pass,
      ocultosTotal: h.tests,
      perfeito: h.tests > 0 && h.pass === h.tests,
      apagado,
      execucoesTrabalho: mine.filter(r => !r.review).length,
      execucoesRevisao: mine.filter(r => r.review).length,
      quemFez: [...new Set(mine.filter(r => !r.review).map(r => r.agent))],
      quemRevisou: [...new Set(mine.filter(r => r.review).map(r => r.agent))],
      vereditos: mine.filter(r => r.review && r.verdict).map(r => ({ agente: r.agent, aprovou: r.verdict.approve, motivo: r.verdict.reason.slice(0, 200) })),
      tokensTrabalho: sum(mine.filter(r => !r.review), 'total'),
      tokensRevisao: sum(mine.filter(r => r.review), 'total'),
      conflitosVistos: [...new Set(mine.flatMap(r => r.conflictsSeen ?? []))]
    };
  }

  // The queue's promises, checked against what actually happened.
  const auditoria = { autoRevisao: [], claimDuplo: [], dependenciaAntes: [] };
  const ordered = [...runs].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const r of ordered.filter(r => r.review)) {
    // The doer is whoever delivered the work last before this review finished.
    const doer = ordered.filter(w => !w.review && w.work === r.work && w.wrote && Date.parse(w.ts) <= Date.parse(r.ts)).pop();
    if (doer && doer.agent === r.agent) auditoria.autoRevisao.push({ review: r.task, agente: r.agent });
  }
  const spans = ordered.map(r => ({ ...r, end: Date.parse(r.ts), start: Date.parse(r.ts) - r.wallMs }));
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.task === b.task && a.start < b.end && b.start < a.end) auditoria.claimDuplo.push({ task: a.task, agentes: [a.agent, b.agent] });
    }
  }
  for (const t of tarefas.filter(t => t.dependsOn)) {
    const dependent = spans.filter(s => s.work === run.ids[t.id] && !s.review).sort((a, b) => a.start - b.start)[0];
    for (const d of t.dependsOn) {
      const dep = byId.get(run.ids[d]);
      if (dependent && dep?.finishedAt && dependent.start < Date.parse(dep.finishedAt)) {
        auditoria.dependenciaAntes.push({ tarefa: t.id, comecou: new Date(dependent.start).toISOString(), dependenciaTerminou: dep.finishedAt });
      }
    }
  }

  const tot = (k, f = () => true) => runs.filter(f).reduce((s, r) => s + (r[k] ?? 0), 0);
  const resumo = {
    cond: run.cond,
    fim: why,
    tarefas: tarefas.length,
    tarefasPerfeitas: Object.values(porTarefa).filter(t => t.perfeito).length,
    trabalhosApagados: Object.entries(porTarefa).filter(([, t]) => t.apagado).map(([id]) => id),
    testesOcultos: `${Object.values(porTarefa).reduce((s, t) => s + t.ocultosPass, 0)}/${Object.values(porTarefa).reduce((s, t) => s + t.ocultosTotal, 0)}`,
    execucoes: runs.length,
    tokensTotal: tot('total'),
    tokensTrabalho: tot('total', r => !r.review),
    tokensRevisao: tot('total', r => r.review),
    chamadas: tot('calls'),
    porAgente: Object.fromEntries(
      AGENTS.map(a => [a.id, { modelo: a.model, execucoes: runs.filter(r => r.agent === a.id).length, tokens: tot('total', r => r.agent === a.id), parouPorCota: run.stopped.has(a.id) }])
    ),
    auditoria
  };
  await writeFile(path.join(run.dir, 'resultado.json'), JSON.stringify({ resumo, porTarefa }, null, 2));
  return { resumo, porTarefa };
}

await mkdir(base, { recursive: true });
console.log(`saida: ${base}`);
const runs = [];
for (const cond of conds) runs.push(await prepare(cond));
for (const run of runs) startRunners(run);
const deadline = Date.now() + minutes * 60_000;
const endings = await Promise.all(runs.map(run => watch(run, deadline)));
for (const run of runs) for (const r of run.runners) kill(r.child);
await sleep(3000);

const all = {};
for (let i = 0; i < runs.length; i++) {
  const { resumo, porTarefa } = await evaluate(runs[i], endings[i]);
  all[runs[i].cond] = resumo;
  console.log(`\n== ${runs[i].cond} (${endings[i]}): perfeitas ${resumo.tarefasPerfeitas}/${resumo.tarefas}, ocultos ${resumo.testesOcultos}, tokens ${resumo.tokensTotal} (revisao ${resumo.tokensRevisao})`);
  for (const [id, t] of Object.entries(porTarefa)) {
    console.log(`  ${id.padEnd(11)} ${String(t.status).padEnd(9)} ocultos ${t.ocultos.padStart(5)}${t.apagado ? ' APAGADO' : ''} fez=${t.quemFez.join('+') || '-'} revisou=${t.quemRevisou.join('+') || '-'} rodadas=${t.rodadasDeRevisao} tok=${t.tokensTrabalho + t.tokensRevisao}`);
  }
  console.log(`  auditoria: ${JSON.stringify(resumo.auditoria)}`);
}
await writeFile(path.join(base, 'resumo.json'), JSON.stringify(all, null, 2));
process.exit(0);
