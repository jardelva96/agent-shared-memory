#!/usr/bin/env node
/**
 * Summarises Test 1 from runs.jsonl: per model and condition, how often the answer was right and
 * what it cost, plus a paired comparison -- the same model, question and repetition under both
 * conditions -- which is the fair way to read a token ratio.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// Graded again from the question files, so a fixed pattern applies to every answer.
const questions = new Map(
  ['perguntas.json', 'perguntas-locais.json']
    .flatMap(f => {
      try {
        return JSON.parse(readFileSync(path.join(here, f), 'utf8'));
      } catch {
        return [];
      }
    })
    .map(q => [q.id, q])
);
const rows = readFileSync(path.join(here, 'resultados', 'economia', 'runs.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(l => JSON.parse(l))
  .filter(r => !r.quota)
  .map(r => {
    const q = questions.get(r.q);
    if (!q || !r.answer) return { ...r, ok: false, score: 0 };
    const missed = q.expect.filter(p => !new RegExp(p, 'is').test(r.answer));
    return { ...r, missed, ok: missed.length === 0, score: (q.expect.length - missed.length) / q.expect.length };
  });

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sum = xs => xs.reduce((a, b) => a + b, 0);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

function block(list) {
  const answered = list.filter(r => r.answer);
  const tooLarge = list.filter(r => /too large/.test(r.error ?? '')).length;
  return {
    n: list.length,
    certas: list.filter(r => r.ok).length,
    taxa: pct(list.filter(r => r.ok).length, list.length),
    nota: list.length ? (sum(list.map(r => r.score)) / list.length).toFixed(2) : '-',
    grandeDemais: tooLarge,
    outrasFalhas: list.filter(r => !r.answer && !/too large/.test(r.error ?? '')).length,
    tokensMediana: median(answered.map(r => r.total)),
    tokensSoma: sum(list.map(r => r.total)),
    entradaMediana: median(answered.map(r => r.prompt)),
    turnosMedia: answered.length ? (sum(answered.map(r => r.turns)) / answered.length).toFixed(1) : '-',
    segundosMediana: median(answered.map(r => r.wallMs / 1000)),
    leuArquivoInteiro: pct(list.filter(r => r.usedReadFile).length, list.length)
  };
}

const models = [...new Set(rows.map(r => r.model))];
const porModelo = {};
for (const m of models) {
  porModelo[m] = {
    arquivo: block(rows.filter(r => r.model === m && r.cond === 'arquivo')),
    ponteiro: block(rows.filter(r => r.model === m && r.cond === 'ponteiro'))
  };
}

// Paired: same model, question and repetition, both conditions answered.
const pares = [];
for (const r of rows.filter(r => r.cond === 'ponteiro')) {
  const twin = rows.find(o => o.cond === 'arquivo' && o.model === r.model && o.q === r.q && o.rep === r.rep);
  if (!twin) continue;
  pares.push({ model: r.model, q: r.q, lang: r.lang, p: r, a: twin });
}
const ambos = pares.filter(x => x.p.answer && x.a.answer);
const razoes = ambos.map(x => x.a.total / x.p.total);
const pareado = {
  pares: pares.length,
  ambosResponderam: ambos.length,
  tokensArquivo: sum(ambos.map(x => x.a.total)),
  tokensPonteiro: sum(ambos.map(x => x.p.total)),
  economiaTotal: pct(sum(ambos.map(x => x.a.total)) - sum(ambos.map(x => x.p.total)), sum(ambos.map(x => x.a.total))),
  razaoMediana: median(razoes)?.toFixed(1),
  certasArquivo: ambos.filter(x => x.a.ok).length,
  certasPonteiro: ambos.filter(x => x.p.ok).length,
  soArquivoAcertou: ambos.filter(x => x.a.ok && !x.p.ok).map(x => `${x.model}|${x.q}`),
  soPonteiroAcertou: ambos.filter(x => !x.a.ok && x.p.ok).map(x => `${x.model}|${x.q}`),
  // The cases the whole-file agent could not even send: the pointer one answered.
  arquivoNaoCoube: pares.filter(x => /too large/.test(x.a.error ?? '')).length,
  arquivoNaoCoubePonteiroAcertou: pares.filter(x => /too large/.test(x.a.error ?? '') && x.p.ok).length
};

const porPergunta = {};
for (const q of [...new Set(rows.map(r => r.q))]) {
  const ps = ambos.filter(x => x.q === q);
  porPergunta[q] = {
    lang: rows.find(r => r.q === q).lang,
    pares: ps.length,
    tokensArquivoMediana: median(ps.map(x => x.a.total)),
    tokensPonteiroMediana: median(ps.map(x => x.p.total)),
    razaoMediana: median(ps.map(x => x.a.total / x.p.total))?.toFixed(1),
    acertoArquivo: pct(rows.filter(r => r.q === q && r.cond === 'arquivo' && r.ok).length, rows.filter(r => r.q === q && r.cond === 'arquivo').length),
    acertoPonteiro: pct(rows.filter(r => r.q === q && r.cond === 'ponteiro' && r.ok).length, rows.filter(r => r.q === q && r.cond === 'ponteiro').length)
  };
}

const geral = { arquivo: block(rows.filter(r => r.cond === 'arquivo')), ponteiro: block(rows.filter(r => r.cond === 'ponteiro')) };
const out = { geral, pareado, porPergunta, porModelo };
writeFileSync(path.join(here, 'resultados', 'economia-resumo.json'), JSON.stringify(out, null, 2));

console.log('GERAL');
console.table(geral);
console.log('PAREADO', pareado);
console.log('POR PERGUNTA');
console.table(porPergunta);
console.log('POR MODELO');
console.table(Object.fromEntries(Object.entries(porModelo).flatMap(([m, v]) => [[`${m} | arquivo`, v.arquivo], [`${m} | ponteiro`, v.ponteiro]])));
