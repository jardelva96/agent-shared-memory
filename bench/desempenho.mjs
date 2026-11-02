#!/usr/bin/env node
/**
 * Test 5 -- how the memory itself performs as a project grows (no model involved).
 *
 *   node bench/desempenho.mjs [--parte escrita,concorrencia,fila,simbolos] [--repo PATH]
 *                            [--eventos 8000] [--agentes 1,5,10,20,40] [--out FILE]
 *
 * escrita       latency of one write as the journal grows, with and without auto-compaction
 * concorrencia  N agent processes writing at once: throughput, latency and nothing lost
 * fila          claim, ready and prime with hundreds to thousands of tasks on disk
 * simbolos      find, refs and symbols on a real repository (--repo, default: this one)
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const lib = await import(pathToFileURL(path.join(RAIZ, 'dist', 'index.js')).href);
const { AgentMemoryService, parsePointer, findSymbol, findReferences, outlineSymbols, codeFiles } = lib;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const partes = flag('parte', 'escrita,concorrencia,fila,simbolos').split(',');
const repo = path.resolve(flag('repo', RAIZ));
const saida = flag('out', path.join(AQUI, 'resultados', 'desempenho.json'));
const EVENTOS = Number(flag('eventos', '8000'));
const AGENTES = flag('agentes', '1,5,10,20,40').split(',').map(Number);

const ms = n => Math.round(n * 100) / 100;
const mediana = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const p95 = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
};

async function tempo(fn) {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

async function projeto(nome, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `asm-perf-${nome}-`));
  const service = new AgentMemoryService(root);
  await service.init(`Perf ${nome}`, config);
  return { root, service };
}

const resultado = { quando: new Date().toISOString(), node: process.version, plataforma: `${os.platform()} ${os.release()}`, cpus: os.cpus().length };

// escrita: one agent, one write after another, as the journal grows.
if (partes.includes('escrita')) {
  resultado.escrita = [];
  for (const [rotulo, autoCompactAfterEvents] of [['sem compactacao', 0], ['compactacao 5000', 5000]]) {
    const { root, service } = await projeto('escrita', { autoCompactAfterEvents });
    await service.register('A');
    const faixas = [];
    let lote = [];
    const TOTAL = EVENTOS, FAIXA = Math.max(100, Math.floor(EVENTOS / 8));
    for (let i = 1; i <= TOTAL; i++) {
      const { ms: t } = await tempo(() =>
        service.activity({ agentId: 'A', type: 'NOTE', description: `nota ${i}`, pointer: parsePointer(`src/f${i % 50}.ts::f${i % 7}`) })
      );
      lote.push(t);
      if (i % FAIXA === 0) {
        faixas.push({ eventos: i, mediana_ms: ms(mediana(lote)), p95_ms: ms(p95(lote)) });
        lote = [];
      }
    }
    resultado.escrita.push({ rotulo, faixas });
    console.log(`escrita (${rotulo}):`, faixas.map(f => `${f.eventos}:${f.mediana_ms}ms`).join('  '));
    await rm(root, { recursive: true, force: true });
  }
}

// concorrencia: N separate processes, each registering and writing M times.
if (partes.includes('concorrencia')) {
  resultado.concorrencia = [];
  const M = 25;
  const filho = path.join(AQUI, 'desempenho-agente.mjs');
  for (const N of AGENTES) {
    const { root, service } = await projeto('conc');
    const inicio = performance.now();
    const latencias = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [filho, root, `AG-${i}`, String(M)], { stdio: ['ignore', 'pipe', 'inherit'] });
          let out = '';
          child.stdout.on('data', d => (out += d));
          child.on('exit', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`agente ${i} saiu com ${code}`))));
        })
      )
    );
    const total = performance.now() - inicio;
    const todas = latencias.flat();
    const eventos = (await readFile(path.join(root, '.agents', 'events', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    const esperados = N * (M + 1);
    const estados = (await readdir(path.join(root, '.agents', 'state'))).filter(f => f.endsWith('.json')).length;
    // The panel must end with every agent's last step: on disk as left by the burst, and as read.
    const ultimos = text => (text.match(new RegExp(`Now: passo ${M - 1}$`, 'gm')) ?? []).length;
    const noDisco = ultimos(await readFile(path.join(root, '.agents', 'SHARED_MEMORY.md'), 'utf8'));
    const lido = ultimos(await service.store.readSharedMemory());
    const linha = {
      agentes: N,
      escritas: N * M,
      segundos: ms(total / 1000),
      escritas_por_s: Math.round((N * M) / (total / 1000)),
      mediana_ms: ms(mediana(todas)),
      p95_ms: ms(p95(todas)),
      eventos_ok: eventos.length === esperados,
      eventos: eventos.length,
      esperados,
      estados_ok: estados === N,
      painel_no_disco_em_dia: noDisco === N,
      painel_lido_em_dia: lido === N
    };
    resultado.concorrencia.push(linha);
    console.log('concorrencia:', JSON.stringify(linha));
    await rm(root, { recursive: true, force: true });
    void service;
  }
}

// fila: the queue with many finished tasks on disk and a few open ones.
if (partes.includes('fila')) {
  resultado.fila = [];
  for (const T of [100, 1000, 3000]) {
    const { root, service } = await projeto('fila');
    await service.register('A');
    const dir = path.join(root, '.agents', 'tasks');
    await mkdir(dir, { recursive: true });
    // Finished history written straight to disk: creating 3000 tasks through the API is the
    // slow part being measured, not the setup.
    const base = Date.now() - T * 1000;
    for (let i = 0; i < T; i++) {
      const at = new Date(base + i * 1000).toISOString();
      const id = `T-OLD${String(i).padStart(5, '0')}`;
      await writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({ id, title: `antiga ${i}`, createdBy: 'A', status: 'DONE', attempts: 1, depth: 0, createdAt: at, updatedAt: at, finishedAt: at })
      );
    }
    for (let i = 0; i < 20; i++) await service.createTask({ title: `aberta ${i}`, createdBy: 'A' });
    const primeira = (await tempo(() => service.claimTask('A'))).ms;
    const claim = [], pronta = [], prime = [];
    for (let i = 0; i < 10; i++) {
      pronta.push((await tempo(() => service.readyTasks('A'))).ms);
      prime.push((await tempo(() => service.prime('A'))).ms);
      const c = await tempo(() => service.claimTask('A'));
      claim.push(c.ms);
      if (c.value) await service.finishTask(c.value.id, 'DONE', 'ok', 'A');
    }
    const linha = { tarefas_no_disco: T + 20, primeiro_claim_ms: ms(primeira), claim_ms: ms(mediana(claim)), pronta_ms: ms(mediana(pronta)), prime_ms: ms(mediana(prime)) };
    resultado.fila.push(linha);
    console.log('fila:', JSON.stringify(linha));
    await rm(root, { recursive: true, force: true });
  }
}

// simbolos: the code tools on a real repository, three times each (the first is cold).
if (partes.includes('simbolos')) {
  let arquivos = 0;
  let maior = { file: '', size: 0, text: '' };
  for await (const file of codeFiles(repo)) {
    arquivos++;
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.length > maior.size) maior = { file, size: text.length, text };
  }
  const nomes = outlineSymbols(maior.text, maior.file).filter(e => e.name.length > 3).map(e => e.name);
  const alvo = nomes[Math.floor(nomes.length / 2)] ?? 'main';
  const medir = async fn => {
    const xs = [];
    for (let i = 0; i < 3; i++) xs.push((await tempo(fn)).ms);
    return { primeira_ms: ms(xs[0]), mediana_ms: ms(mediana(xs)) };
  };
  resultado.simbolos = {
    arquivos,
    maior_arquivo_kb: Math.round(maior.size / 1024),
    find: await medir(() => findSymbol(repo, alvo)),
    refs: await medir(() => findReferences(repo, alvo)),
    outline_maior_arquivo: await medir(async () => outlineSymbols(maior.text, maior.file))
  };
  console.log('simbolos:', JSON.stringify(resultado.simbolos));
}

await mkdir(path.dirname(saida), { recursive: true });
await writeFile(saida, JSON.stringify(resultado, null, 2));
console.log(`\nGravado em ${saida}`);
