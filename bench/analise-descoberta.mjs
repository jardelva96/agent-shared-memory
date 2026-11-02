#!/usr/bin/env node
/**
 * Summarises Test 4: for each model and question, the same question answered with a text search kit
 * and with the symbol kit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const questions = new Map(
  ['perguntas.json', 'perguntas-locais.json']
    .map(f => path.join(here, f))
    .filter(existsSync)
    .flatMap(f => JSON.parse(readFileSync(f, 'utf8')))
    .map(q => [q.id, q])
);
const rows = readFileSync(path.join(here, 'resultados', 'descoberta', 'runs.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(l => JSON.parse(l))
  .filter(r => !r.quota)
  .map(r => {
    const q = questions.get(r.q);
    const ok = Boolean(q && r.answer && q.expect.every(p => new RegExp(p, 'is').test(r.answer)));
    return { ...r, ok };
  });

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const sum = xs => xs.reduce((a, b) => a + b, 0);

const porCond = {};
for (const cond of ['texto', 'simbolo']) {
  const rs = rows.filter(r => r.cond === cond);
  porCond[cond] = {
    rodadas: rs.length,
    certas: rs.filter(r => r.ok).length,
    tokens: sum(rs.map(r => r.total)),
    tokensMediana: median(rs.filter(r => r.answer).map(r => r.total)),
    turnosMedia: +(sum(rs.map(r => r.turns)) / Math.max(1, rs.length)).toFixed(1)
  };
}
const pares = [];
for (const r of rows.filter(r => r.cond === 'simbolo')) {
  const t = rows.find(o => o.cond === 'texto' && o.model === r.model && o.q === r.q);
  if (t && t.answer && r.answer) pares.push({ q: r.q, lang: r.lang, model: r.model, texto: t.total, simbolo: r.total, okTexto: t.ok, okSimbolo: r.ok });
}
const porPergunta = [...new Set(pares.map(p => p.q))].map(q => {
  const ps = pares.filter(p => p.q === q);
  return {
    pergunta: q,
    linguagem: ps[0].lang,
    tokens_texto: Math.round(median(ps.map(p => p.texto))),
    tokens_simbolo: Math.round(median(ps.map(p => p.simbolo))),
    acerto_texto: ps.filter(p => p.okTexto).length / ps.length,
    acerto_simbolo: ps.filter(p => p.okSimbolo).length / ps.length
  };
});
const resumo = {
  porCond,
  pares: pares.length,
  tokensTexto: sum(pares.map(p => p.texto)),
  tokensSimbolo: sum(pares.map(p => p.simbolo)),
  economia: pares.length ? +(1 - sum(pares.map(p => p.simbolo)) / sum(pares.map(p => p.texto))).toFixed(4) : null,
  certasTexto: pares.filter(p => p.okTexto).length,
  certasSimbolo: pares.filter(p => p.okSimbolo).length,
  porPergunta
};
writeFileSync(path.join(here, 'resultados', 'descoberta-resumo.json'), JSON.stringify(resumo, null, 2));
console.log(JSON.stringify({ ...resumo, porPergunta: undefined }, null, 1));
console.table(porPergunta);
