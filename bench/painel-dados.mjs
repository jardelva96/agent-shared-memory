#!/usr/bin/env node
/**
 * Turns the benchmark results into the small, aggregated tables the report page reads.
 *
 * Only numbers and labels leave this machine: no answers, no code, no file contents. The
 * questions about private projects are named by what they are ("C# enum, 97 kB file"),
 * not by the project's own class names.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const res = path.join(here, 'resultados');
const out = path.join(res, 'painel');
mkdirSync(out, { recursive: true });
const json = f => JSON.parse(readFileSync(f, 'utf8'));
const jsonl = f => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const write = (name, rows) => writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rows, null, 1));
const share = (a, b) => (b ? +(a / b).toFixed(4) : null);
const figuras = [];
const fig = (chave, valor) => figuras.push({ chave, valor: typeof valor === 'number' && valor > 50 ? Math.round(valor) : valor });

// Test 0 -- slicing against the compilers.
const recorte = json(path.join(res, 'recorte.json')).result;
const KINDS = ['exato', 'cortado', 'passou', 'errado', 'nao_achou'];
const recorteRows = [];
const tiposRows = [];
const NOMES = {
  MethodDeclaration: 'Método', FunctionDeclaration: 'Função', FunctionDef: 'Função', ClassDeclaration: 'Classe', ClassDef: 'Classe',
  PropertyDeclaration: 'Propriedade', FieldDeclaration: 'Campo / constante', RecordDeclaration: 'Record', EnumDeclaration: 'Enum',
  InterfaceDeclaration: 'Interface', TypeAliasDeclaration: 'Tipo (type)', VariableStatement: 'Constante de topo', DelegateDeclaration: 'Delegate'
};
let medidas = 0;
for (const [lang, s] of Object.entries(recorte)) {
  const total = KINDS.reduce((sum, k) => sum + s.depois[k], 0);
  medidas += total;
  recorteRows.push({
    linguagem: lang,
    arquivos: s.arquivos,
    medidas: total,
    antes_exato: share(s.antes.exato, total),
    depois_exato: share(s.depois.exato, total),
    antes_errado: share(s.antes.errado, total),
    depois_errado: share(s.depois.errado, total),
    antes_cortado: share(s.antes.cortado, total),
    depois_cortado: share(s.depois.cortado, total)
  });
  for (const [kind, t] of Object.entries(s.porTipo)) {
    if (t.n < 10) continue;
    tiposRows.push({ chave: `${lang}|${kind}`, linguagem: lang, tipo: NOMES[kind] ?? kind, n: t.n, antes_exato: share(t.antesExato, t.n), depois_exato: share(t.depoisExato, t.n) });
  }
}
tiposRows.sort((a, b) => a.antes_exato - b.antes_exato);
write('recorte', recorteRows);
write('recorte_tipos', tiposRows);
fig('recorte_medidas', medidas);
fig('recorte_arquivos', recorteRows.reduce((s, r) => s + r.arquivos, 0));

// Test 1 -- tokens and correctness, read by whole file or by pointer.
const eco = json(path.join(res, 'economia-resumo.json'));
const ROTULO = {
  'ts-readpointer': 'TS: limite de leitura (constante fora da função)',
  'ts-settlereview': 'TS: regra do painel de revisores',
  'ts-claim': 'TS: quem pega a próxima tarefa',
  'ts-config': 'TS: campos e valores padrão (2 arquivos pequenos)',
  'cs-authorterms': 'C#: classe de termos, arquivo de 97 kB',
  'cs-estado': 'C#: enum, arquivo de 97 kB',
  'cs-denunciar': 'C#: método + constante fora dele, 74 kB',
  'cs-comentar': 'C#: método + 2 constantes fora dele, 74 kB',
  'py-numero': 'Python: função de 3 linhas, arquivo de 58 kB',
  'py-planejar': 'Python: função de 35 linhas, arquivo de 58 kB'
};
write(
  'economia_perguntas',
  Object.entries(eco.porPergunta).map(([q, v]) => ({
    pergunta: ROTULO[q] ?? q,
    linguagem: v.lang,
    pares: v.pares,
    tokens_arquivo: Math.round(v.tokensArquivoMediana),
    tokens_ponteiro: Math.round(v.tokensPonteiroMediana),
    vezes_menos: v.razaoMediana === undefined ? null : Number(v.razaoMediana),
    acerto_arquivo: parseFloat(v.acertoArquivo) / 100,
    acerto_ponteiro: parseFloat(v.acertoPonteiro) / 100
  }))
);
const PROV = m => (/gemini/.test(m) ? 'Google Gemini' : /:free/.test(m) ? 'OpenRouter' : 'Groq');
write(
  'economia_modelos',
  Object.entries(eco.porModelo)
    .filter(([, v]) => v.arquivo.n + v.ponteiro.n >= 4)
    .map(([m, v]) => ({
      modelo: m.replace(/:free$/, '').split('/').pop(),
      provedor: PROV(m),
      rodadas: v.arquivo.n + v.ponteiro.n,
      acerto_arquivo: share(v.arquivo.certas, v.arquivo.n),
      acerto_ponteiro: share(v.ponteiro.certas, v.ponteiro.n),
      nao_coube: v.arquivo.grandeDemais,
      tokens_arquivo: v.arquivo.tokensMediana == null ? null : Math.round(v.arquivo.tokensMediana),
      tokens_ponteiro: v.ponteiro.tokensMediana == null ? null : Math.round(v.ponteiro.tokensMediana)
    }))
    .sort((a, b) => b.rodadas - a.rodadas)
);
const p = eco.pareado;
fig('eco_rodadas', eco.geral.arquivo.n + eco.geral.ponteiro.n);
fig('eco_modelos', Object.keys(eco.porModelo).length);
fig('eco_economia', share(p.tokensArquivo - p.tokensPonteiro, p.tokensArquivo));
fig('eco_pares_ambos', p.ambosResponderam);
fig('eco_certas_arquivo', p.certasArquivo);
fig('eco_certas_ponteiro', p.certasPonteiro);
fig('eco_mediana_arquivo', eco.geral.arquivo.tokensMediana);
fig('eco_mediana_ponteiro', eco.geral.ponteiro.tokensMediana);
fig('eco_acerto_arquivo', share(eco.geral.arquivo.certas, eco.geral.arquivo.n));
fig('eco_acerto_ponteiro', share(eco.geral.ponteiro.certas, eco.geral.ponteiro.n));
fig('eco_nao_coube', p.arquivoNaoCoube);
fig('eco_nao_coube_ponteiro_certo', p.arquivoNaoCoubePonteiroAcertou);
fig('eco_leu_inteiro_ponteiro', parseFloat(eco.geral.ponteiro.leuArquivoInteiro) / 100);

// Tests 2 and 3 -- the queue with several agents, graded by hidden tests.
const lote = readdirSync(path.join(res, 'multiagente')).filter(d => existsSync(path.join(res, 'multiagente', d, 'resumo.json'))).sort().pop();
const loteDir = path.join(res, 'multiagente', lote);
const COND = { sem_memoria: 'Sem memória', solo: 'Com memória', revisao: 'Com memória + revisão', aviso: 'Com memória + aviso ao gravar', trava: 'Trava de leitura (sem memória)', simbolo: 'Edição por símbolo (versão nova)', simbolo_revisao: 'Versão nova + revisão' };
const tarefasRows = [];
const condRows = [];
let auditadas = 0;
const violacoes = { autoRevisao: 0, claimDuplo: 0, dependenciaAntes: 0 };
let aprovacoes = 0;
let aprovacoesCertas = 0;
let rejeicoes = 0;
for (const cond of ['sem_memoria', 'solo', 'revisao']) {
  const dir = path.join(loteDir, cond);
  if (!existsSync(path.join(dir, 'resultado.json'))) continue;
  const { resumo, porTarefa } = json(path.join(dir, 'resultado.json'));
  const runs = jsonl(path.join(dir, 'execucoes.jsonl'));
  auditadas += runs.length;
  for (const k of Object.keys(violacoes)) violacoes[k] += resumo.auditoria[k].length;
  const texto = existsSync(path.join(dir, 'projeto', 'src', 'texto.js')) ? readFileSync(path.join(dir, 'projeto', 'src', 'texto.js'), 'utf8') : '';
  let entregues = 0;
  let perfeitasEntregues = 0;
  let passEntregues = 0;
  let totalEntregues = 0;
  let falhasLimite = 0;
  let apagados = 0;
  for (const [id, t] of Object.entries(porTarefa)) {
    const mine = runs.filter(r => r.workKey === id && !r.review);
    const entregue = mine.some(r => r.wrote);
    const limite = !entregue && mine.some(r => /gave up|daily quota/.test(r.error ?? ''));
    const apagado = t.apagado ?? (entregue && id === 'contar' && /contarPalavras[\s\S]*nao implementado/.test(texto)) ?? false;
    if (entregue) {
      entregues++;
      passEntregues += t.ocultosPass;
      totalEntregues += t.ocultosTotal;
      if (t.perfeito) perfeitasEntregues++;
    }
    if (limite) falhasLimite++;
    if (apagado) apagados++;
    for (const v of t.vereditos ?? []) {
      if (v.aprovou) {
        aprovacoes++;
        if (t.perfeito) aprovacoesCertas++;
      } else rejeicoes++;
    }
    tarefasRows.push({
      chave: `${cond}|${id}`,
      condicao: COND[cond],
      tarefa: id,
      resultado: limite ? 'Não rodou (limite por minuto)' : apagado ? 'Apagada por outro agente' : t.perfeito ? 'Perfeita' : entregue ? 'Com defeito' : 'Não entregue',
      testes_ocultos: t.ocultosTotal ? share(t.ocultosPass, t.ocultosTotal) : null,
      fez: t.quemFez.join(' + ') || '—',
      revisou: t.quemRevisou.join(' + ') || '—',
      rejeicoes: t.rodadasDeRevisao,
      tokens: t.tokensTrabalho + t.tokensRevisao
    });
  }
  condRows.push({
    condicao: COND[cond],
    tarefas: resumo.tarefas,
    entregues,
    perfeitas: perfeitasEntregues,
    acerto_entregues: share(passEntregues, totalEntregues),
    nao_rodou_limite: falhasLimite,
    apagadas: apagados,
    tokens: resumo.tokensTotal,
    tokens_por_entregue: entregues ? Math.round(resumo.tokensTotal / entregues) : null,
    tokens_revisao: resumo.tokensRevisao
  });
}
write('multiagente_tarefas', tarefasRows);
write('multiagente_condicoes', condRows);
fig('fila_execucoes', auditadas);
fig('fila_claim_duplo', violacoes.claimDuplo);
fig('fila_auto_revisao', violacoes.autoRevisao);
fig('fila_dependencia_antes', violacoes.dependenciaAntes);
fig('rev_aprovacoes', aprovacoes);
fig('rev_aprovacoes_certas', aprovacoesCertas);
fig('rev_rejeicoes', rejeicoes);

// The race: two agents on one file at the same time. A trial counts as a race only when both
// agents delivered: when one returned nothing, nobody could overwrite anybody.
const corridaRows = [];
const fontes = [
  ...['sem_memoria', 'solo'].map(cond => ({ dir: path.join(loteDir, cond), cond, versao: 2 })),
  ...['corrida', 'corrida-v2', 'corrida-v3'].flatMap((pasta, i) => {
    const dir = path.join(res, pasta);
    return existsSync(dir)
      ? readdirSync(dir).sort().flatMap(stamp => ['sem_memoria', 'solo', 'aviso', 'trava', 'simbolo'].map(cond => ({ dir: path.join(dir, stamp, cond), cond, versao: i + 1 })))
      : [];
  })
];
for (const { dir, cond, versao } of fontes) {
  const f = path.join(dir, 'resultado.json');
  if (!existsSync(f)) continue;
  // The first draft of these two was replaced after the first trial.
  if ((cond === 'aviso' || cond === 'trava') && versao === 1) continue;
  const { porTarefa } = json(f);
  const q = porTarefa.quebrar;
  const c = porTarefa.contar;
  const runs = jsonl(path.join(dir, 'execucoes.jsonl'));
  const delivered = key => runs.some(r => r.workKey === key && !r.review && r.wrote);
  const texto = readFileSync(path.join(dir, 'projeto', 'src', 'texto.js'), 'utf8');
  const stub = name => new RegExp(`export function ${name}[^]*?nao implementado`).test(texto.split(/\n(?=export )/).find(p => p.includes(`function ${name}`)) ?? '');
  const apagou = (delivered('quebrar') && stub('quebrarLinhas')) || (delivered('contar') && stub('contarPalavras'));
  corridaRows.push({
    chave: path.relative(res, dir).replace(/\\/g, '/'),
    condicao: COND[cond],
    disputa: delivered('quebrar') && delivered('contar'),
    apagou,
    os_dois_perfeitos: Boolean(q.perfeito && c.perfeito),
    testes_ocultos: share(q.ocultosPass + c.ocultosPass, q.ocultosTotal + c.ocultosTotal),
    tokens: q.tokensTrabalho + c.tokensTrabalho
  });
}
write('corrida', corridaRows);
const resumoCorrida = ['sem_memoria', 'solo', 'aviso', 'trava', 'simbolo']
  .map(cond => COND[cond])
  .filter(nome => corridaRows.some(r => r.condicao === nome))
  .map(nome => {
    const all = corridaRows.filter(r => r.condicao === nome);
    const rs = all.filter(r => r.disputa);
    return {
      condicao: nome,
      rodadas: all.length,
      disputas: rs.length,
      apagou: rs.filter(r => r.apagou).length,
      os_dois_perfeitos: rs.filter(r => r.os_dois_perfeitos).length,
      sem_disputa: all.length - rs.length
    };
  });
write('corrida_resumo', resumoCorrida);
fig('corrida_rodadas', corridaRows.length);
fig('corrida_disputas', corridaRows.filter(r => r.disputa).length);
// The head-to-head of the last batch: the same pairs of agents, whole file against by symbol.
const v3 = nome => corridaRows.filter(r => r.chave.startsWith('corrida-v3') && r.condicao === COND[nome]);
for (const [key, nome] of [['v3_sem', 'sem_memoria'], ['v3_sim', 'simbolo']]) {
  const rs = v3(nome);
  if (!rs.length) continue;
  fig(`${key}_rodadas`, rs.length);
  fig(`${key}_apagou`, rs.filter(r => r.apagou).length);
  fig(`${key}_disputas`, rs.filter(r => r.disputa).length);
  fig(`${key}_tokens`, rs.reduce((s, r) => s + r.tokens, 0));
  fig(`${key}_testes`, +(rs.reduce((s, r) => s + r.testes_ocultos, 0) / rs.length).toFixed(4));
}
if (v3('sem_memoria').length && v3('simbolo').length) {
  const a = v3('sem_memoria').reduce((s, r) => s + r.tokens, 0);
  const b = v3('simbolo').reduce((s, r) => s + r.tokens, 0);
  fig('v3_economia', +((a - b) / a).toFixed(4));
}

// The whole queue again with the new version: the same ten tasks, old way against new way.
const v2Base = path.join(res, 'multiagente-v2');
const v2Stamp = existsSync(v2Base) ? readdirSync(v2Base).filter(d => existsSync(path.join(v2Base, d, 'resumo.json'))).sort().pop() : undefined;
const v2Rows = [];
if (v2Stamp) {
  for (const cond of ['sem_memoria', 'simbolo', 'simbolo_revisao']) {
    const dir = path.join(v2Base, v2Stamp, cond);
    if (!existsSync(path.join(dir, 'resultado.json'))) continue;
    const { resumo, porTarefa } = json(path.join(dir, 'resultado.json'));
    const runs = jsonl(path.join(dir, 'execucoes.jsonl'));
    let entregues = 0, perfeitas = 0, pass = 0, total = 0, falsas = 0, aprov = 0, rejeicoes = 0;
    for (const [id, t] of Object.entries(porTarefa)) {
      if (!runs.some(r => r.workKey === id && !r.review && r.wrote)) continue;
      entregues++;
      pass += t.ocultosPass;
      total += t.ocultosTotal;
      if (t.perfeito) perfeitas++;
      for (const v of t.vereditos ?? []) {
        if (v.aprovou) {
          aprov++;
          if (!t.perfeito) falsas++;
        } else rejeicoes++;
      }
    }
    v2Rows.push({
      condicao: COND[cond],
      tarefas: resumo.tarefas,
      entregues,
      perfeitas,
      acerto_entregues: share(pass, total),
      apagadas: resumo.trabalhosApagados?.length ?? 0,
      aprovacoes: aprov,
      aprovacoes_erradas: falsas,
      rejeicoes,
      tokens: resumo.tokensTotal,
      tokens_por_entregue: entregues ? Math.round(resumo.tokensTotal / entregues) : null
    });
  }
}
write('multiagente_v2', v2Rows);

// Finding code nobody pointed at: a text search kit against the symbol kit.
const descoberta = existsSync(path.join(res, 'descoberta-resumo.json')) ? json(path.join(res, 'descoberta-resumo.json')) : undefined;
write(
  'descoberta',
  (descoberta?.porPergunta ?? []).map(p => ({ ...p, pergunta: ROTULO[p.pergunta] ?? p.pergunta }))
);
if (descoberta) {
  fig('desc_pares', descoberta.pares);
  fig('desc_economia', descoberta.economia);
  fig('desc_certas_texto', descoberta.certasTexto);
  fig('desc_certas_simbolo', descoberta.certasSimbolo);
  fig('desc_tokens_texto', descoberta.tokensTexto);
  fig('desc_tokens_simbolo', descoberta.tokensSimbolo);
}

// What the measuring found wrong in the system, and what was done about it.
write('defeitos', [
  { n: 1, defeito: 'Um tipo usado numa assinatura ganhava da própria declaração', efeito: 'Pedir ToolDefinition devolvia a função buildTools: código errado, entregue com confiança', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 2, defeito: 'Chave { na linha de baixo, como em C# e Java', efeito: 'Método voltava só com a assinatura; enum voltava com 1 dos 8 valores', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 3, defeito: 'O tipo antes do nome (bool Nome(), string? Nome) era tratado como chamada', efeito: 'A linha var x = Nome(); ganhava da declaração do método', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 4, defeito: 'Nome entre aspas, chave dentro de regex e # do Python confundiam a contagem', efeito: 'Recorte pegava outro trecho ou ia até o fim do arquivo', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 5, defeito: 'TypeScript sem ponto e vírgula e texto de várias linhas', efeito: 'Recorte engolia as declarações seguintes ou parava no meio do texto', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 6, defeito: 'Aviso de conflito chegava só para quem entrava no arquivo depois', efeito: 'Quem chegou primeiro gravou por cima e apagou o trabalho do outro', onde: 'Memória (service.ts)', situacao: 'Corrigido: agora avisa os dois e avisa a cada gravação' },
  { n: 7, defeito: 'Ponteiro para membro ignorava o dono (Tarefa.status)', efeito: 'Pedir uma propriedade trazia uma variável local de mesmo nome em outro método', onde: 'Recorte (extract.ts)', situacao: 'Corrigido: procura dentro do tipo primeiro, com teste' },
  { n: 8, defeito: 'Decorador na linha da declaração (@IsString() title!: string)', efeito: 'Propriedade decorada não era achada', onde: 'Recorte (extract.ts)', situacao: 'Corrigido, com teste' },
  { n: 9, defeito: 'Agentes reescreviam o arquivo inteiro para mudar uma função', efeito: 'Cópia velha apagava o trabalho do outro agente no mesmo arquivo', onde: 'Ferramentas de edição', situacao: 'Novo: edição por símbolo, que relê o arquivo sob trava na hora de gravar' },
  { n: 10, defeito: 'Edição que quebrava a sintaxe era gravada', efeito: 'Um agente escreveu uma regex sem a barra final e os testes dos dois agentes pararam de carregar', onde: 'Ferramentas de edição', situacao: 'Corrigido: recusada antes de gravar, com a linha do erro' },
  { n: 11, defeito: 'Agente sem cota marcava a tarefa como falha', efeito: 'Código certo (10 de 10 testes) foi jogado fora porque a cota do dia acabou no meio', onde: 'Fila (runner)', situacao: 'Corrigido: saída 75 devolve a tarefa para outro agente' }
]);

// The symbol outline against the compilers.
const outline = existsSync(path.join(res, 'outline.json')) ? json(path.join(res, 'outline.json')) : {};
write(
  'outline',
  Object.entries(outline).map(([linguagem, o]) => ({ linguagem, declaracoes: o.declaracoes, cobertura: o.cobertura, precisao: o.precisao }))
);

// What each tool offers, from its own public documentation. MCP Agent Mail is not in the
// table: its license forbids Anthropic and agents acting for it from analysing or comparing it.
const S = 'Sim', N = 'Não', P = 'Parcial';
write('comparacao', [
  { recurso: 'Funciona com agentes de vários fornecedores na mesma fila', nosso: S, beads: S, serena: S, agent_teams: N },
  { recurso: 'Fila de tarefas com dependências', nosso: S, beads: S, serena: N, agent_teams: S },
  { recurso: 'Prioridade e lista do que está pronto', nosso: S, beads: S, serena: N, agent_teams: P },
  { recurso: 'Revisão obrigatória por outro agente, com maioria', nosso: S, beads: N, serena: N, agent_teams: P },
  { recurso: 'Mensagens entre agentes', nosso: S, beads: S, serena: N, agent_teams: S },
  { recurso: 'Reserva de arquivo com prazo, barrada ao gravar e no commit', nosso: S, beads: P, serena: N, agent_teams: N },
  { recurso: 'Aviso automático quando outro agente grava o mesmo arquivo', nosso: S, beads: N, serena: N, agent_teams: N },
  { recurso: 'Ler código por função ou classe', nosso: S, beads: N, serena: S, agent_teams: P },
  { recurso: 'Editar uma função sem regravar o arquivo', nosso: S, beads: N, serena: S, agent_teams: S },
  { recurso: 'Recusar, antes de gravar, uma edição que quebra a sintaxe', nosso: S, beads: N, serena: P, agent_teams: N },
  { recurso: 'Renomear em todo o projeto, com prévia', nosso: S, beads: N, serena: S, agent_teams: N },
  { recurso: 'Funciona sem instalar servidor de linguagem', nosso: S, beads: S, serena: N, agent_teams: S },
  { recurso: 'Precisão medida e publicada contra compilador', nosso: S, beads: N, serena: N, agent_teams: N },
  { recurso: 'Painel ao vivo', nosso: S, beads: P, serena: S, agent_teams: P },
  { recurso: 'Histórico completo de uma tarefa', nosso: S, beads: S, serena: N, agent_teams: P },
  { recurso: 'Vários computadores', nosso: 'Sim, ao vivo', beads: 'Sim, por sincronização', serena: N, agent_teams: N },
  { recurso: 'Usuários hoje', nosso: 'Nenhum ainda', beads: 'Milhares', serena: 'Milhares', agent_teams: 'Quem usa Claude Code (experimental)' }
]);

// Facts of the setup the page names in its sentences.
fig('data_medicao', '1º e 2 de novembro de 2026');
fig('fila_agentes', 4);
fig('fila_tarefas', json(path.join(loteDir, 'resumo.json')).revisao?.tarefas ?? 10);
fig('groq_tpm', 8000);
fig('tentativas_antigas', 6);
fig('testes_antes', 166);
fig('testes_depois', 202);

write('figuras', figuras);
console.log(`painel: ${readdirSync(out).length} arquivos em ${out}`);
console.log(JSON.stringify({ condRows, resumoCorrida, figuras }, null, 1).slice(0, 4000));
