<img src="docs/logo.svg" alt="Logo do Agent Shared Memory" width="96">

# Agent Shared Memory

[English](README.md)

**Novo na 1.5.0:** uma trava do terminal que impede comandos git de mexer numa pasta onde outra
sessão está trabalhando, e sete correções achadas no uso real, cada uma com teste. Veja o
[changelog](CHANGELOG.md).

Memória operacional compartilhada para vários agentes de IA trabalhando no mesmo repositório.

**Agent Shared Memory** é uma ferramenta local para coordenar agentes de programação como Codex,
Claude Code, Cursor, modelos via Ollama ou qualquer runner que consiga executar comandos. Ela cria
uma pasta `.agents/` dentro do projeto monitorado e mantém, em arquivos versionáveis ou locais, o
estado atual de cada agente, intenções de mudança, histórico, mensagens, fila de tarefas,
agendamentos, revisões e um dashboard ao vivo.

A proposta é simples: antes de uma alteração relevante, o agente anuncia **o que vai fazer**, **onde vai mexer** e **por quê**. Durante o trabalho, todos conseguem ver o estado atual dos demais. Depois da alteração, o agente registra o resultado no seu próprio histórico.

## O que ele faz que as outras ferramentas não fazem

- **Um comando para o Claude Code.** `agent-memory setup claude` instala os ganchos e o
  servidor MCP: toda sessão começa com um resumo (`prime`), gravar num arquivo que outro agente
  reservou é recusado antes de acontecer, e cada gravação avisa os outros agentes daquele
  arquivo que a cópia deles ficou velha. `agent-memory setup git` adiciona uma trava no commit.
- **Reserva de arquivo.** `agent-memory reserve --agent A src/auth/` reserva arquivos, pastas
  ou padrões por um tempo, exclusiva ou compartilhada, tudo ou nada. Os outros são barrados na
  hora de gravar e no commit; a reserva expira sozinha.
- **Editar por símbolo, com segurança.** `memory_replace_symbol` troca uma função, método ou
  classe no lugar. O arquivo é relido sob trava na hora da edição, então dois agentes mudando
  duas funções do mesmo arquivo mantêm os dois trabalhos, e uma edição que quebraria a sintaxe
  do arquivo é recusada com a linha do erro, antes de gravar qualquer coisa.
- **Ler por símbolo, sem servidor de linguagem.** `symbols <arquivo>`, `find <Nome|Tipo.membro>`,
  `refs <Nome>`, `rename <Nome> <NovoNome>` (mostra o plano antes; `--apply` grava) e
  `memory_read_pointer "arquivo::Tipo.membro"`. Funciona em TypeScript, JavaScript, Python, C#,
  Java, Go e outras, sem instalar mais nada.
- **Vários computadores, ao vivo.** `agent-memory hub` compartilha uma memória pela rede, com
  senha; nos outros computadores, defina `AGENT_MEMORY_REMOTE` e `AGENT_MEMORY_TOKEN`. Um
  arquivo reservado num computador é barrado no outro na mesma hora. O código continua sendo
  lido e editado em cada máquina.
- **Agentes de qualquer fornecedor na mesma fila,** com prioridade (`--priority 0-4`),
  dependências, `task ready`, `task show` (a história inteira de uma tarefa) e revisão que nunca
  vai para quem fez o trabalho, decidida por maioria quando você pede um painel.

### Resultados medidos

Todo número vem de `bench/` e pode ser medido de novo (detalhes no [CHANGELOG.md](CHANGELOG.md)):

| O quê | Resultado |
|---|---|
| Dois agentes mudando duas funções do mesmo arquivo ao mesmo tempo (8 disputas, modelos grátis) | gravando o arquivo inteiro, um apagou o trabalho do outro 3 de 7 vezes; por símbolo, 0 de 8, com 96% dos testes escondidos passando contra 73%, e 46% menos tokens |
| Ler pelo ponteiro em vez do arquivo inteiro (213 rodadas, 10 modelos) | mesmas respostas certas, 66% menos tokens |
| Achar o código sabendo só o nome: busca por texto contra as ferramentas de símbolo (40 rodadas) | mesmas respostas certas, 75% menos tokens com as ferramentas de símbolo |
| Ponteiro devolve exatamente a declaração pedida (9.400 declarações, contra os compiladores) | C# 99,4%, TypeScript 99,3%, Python 98,8% |
| Lista de funções contra os compiladores | acha de 98,5% a 99,96% das declarações; de 99,6% a 100% do que lista é real |
| Fila com quatro agentes de dois fornecedores | nenhuma tarefa pega duas vezes, nenhuma autorrevisão, nenhuma dependência furada, em 40 execuções auditadas |
| Uma escrita na memória, com 8.000 eventos no journal | 13 ms |
| Pegar uma tarefa com 3.000 tarefas no disco | 27 ms |
| Achar uma função em 609 arquivos (8,7 MB) | 0,15 s |
| 40 processos de agente escrevendo ao mesmo tempo | cerca de 120 escritas/s, nenhum evento perdido, nenhum arquivo corrompido, painel em dia |


## Por que existe

Quando dois ou mais agentes trabalham no mesmo código, o problema não é só concorrência de Git. O
problema real é operacional: um agente não sabe o que o outro leu, que arquivo pretende tocar, qual
mudança já foi feita, quem está bloqueado, qual tarefa ficou pendente e se uma revisão realmente
aconteceu.

Este projeto resolve isso com uma coordenação simples, local-first e auditável:

- **memória compartilhada** gerada automaticamente em `.agents/SHARED_MEMORY.md`;
- **estado individual** por agente em JSON e histórico append-only em Markdown;
- **detecção de sobreposição** por ponteiros semânticos como `arquivo::Classe.metodo()`;
- **mensagens diretas** e dependências explícitas entre agentes;
- **fila durável de tarefas**, com claim, retry, dead-letter, dependências e síntese;
- **revisão obrigatória**, incluindo painel aberto com `--reviewers N` e decisão por maioria;
- **runner local** para executar agentes por CLI, API local ou scripts próprios;
- **servidor MCP** para expor tudo como ferramentas nativas a clientes compatíveis;
- **watcher de Git** para comparar mudanças reais do working tree com o que foi declarado;
- **dashboard local** via SSE para acompanhar agentes, conflitos, inbox e atividade;
- **reserva de arquivos** imposta onde a escrita acontece (ganchos do Claude Code, pre-commit do git);
- **ferramentas de símbolo** para listar, achar, editar e renomear código pelo nome, com checagem de sintaxe antes de gravar;
- **um hub** que compartilha a mesma memória entre máquinas.

## Status do projeto

- Linguagem: TypeScript, Node.js 20+.
- Pacote: `agent-shared-memory`.
- Binário: `agent-memory`.
- Versão atual: `1.4.0`.
- Testes locais: `npm test`.
- Build: `npm run build`.

## Estrutura gerada no projeto monitorado

```text
.agents/
├── SHARED_MEMORY.md       # visão central: o que acontece agora
├── config.json
├── state/
│   ├── AGENT-01.json      # estado atual estruturado
│   └── AGENT-02.json
├── history/
│   ├── AGENT-01.md        # histórico individual append-only
│   ├── AGENT-02.md
│   └── archive/           # históricos rotacionados por compact --history
├── events/
│   ├── events.jsonl       # journal global de eventos
│   └── archive/           # eventos antigos, criado por compact
├── inbox/
│   ├── AGENT-02.jsonl     # mensagens endereçadas ao agente
│   └── AGENT-02.cursor.json
├── tasks/
│   ├── T-XXXX.json        # fila de trabalho durável
│   └── archive/           # tarefas fechadas antigas
├── schedules/
│   └── S-XXXX.json        # agendamentos cron
├── reservations.json      # arquivos reservados pelos agentes
├── facts.json             # fatos que toda sessão recebe
└── .locks/                # locks internos de escrita
```

## Princípios

1. Todo agente lê a memória compartilhada antes de uma alteração relevante.
2. Todo agente registra `INTENT` antes de alterar código.
3. Ao terminar uma ação, registra `CHANGED`, `CREATED`, `TESTING` ou `DONE`.
4. Ponteiros usam arquivo + símbolo + parâmetro, evitando números de linha frágeis.
5. Cada agente possui um histórico separado.
6. O arquivo central é **gerado**, nunca editado manualmente pelos agentes.
7. Conflitos são avisados, não bloqueados automaticamente.

## Requisitos

- Node.js 20+
- npm

## Comece em 2 minutos

```bash
npm install
npm run build
npm link

cd /caminho/do/projeto
agent-memory init --name "Meu Projeto"
agent-memory register --agent AGENT-01 --role Backend --task AUTH-184
agent-memory status
agent-memory serve

# Com Claude Code: ganchos e servidor MCP num passo só
agent-memory setup claude
```

Abra o dashboard local:

```text
http://127.0.0.1:4317
```

Em outro terminal ou em outro agente, use outro id apontando para a mesma raiz:

```bash
agent-memory register --agent AGENT-02 --role Frontend --task UI-210
agent-memory intent --agent AGENT-02 --task UI-210 \
  --pointer "src/app/page.tsx::HomePage" \
  --message "Ajustar o estado vazio da tela inicial"
```

## Instalação

```bash
npm install
npm run build
npm link
```

Agora o comando `agent-memory` estará disponível localmente.

Sem `npm link`, também é possível usar:

```bash
npm run dev -- help
```

## Inicializar em outro projeto

Entre no repositório que será coordenado:

```bash
cd meu-backend
agent-memory init --name "Meu Backend"
```

Ou informe a raiz explicitamente:

```bash
agent-memory init --root /caminho/meu-backend --name "Meu Backend"
```

## Registrar agentes

```bash
agent-memory register \
  --agent AGENT-01 \
  --role Backend \
  --task AUTH-184

agent-memory register \
  --agent AGENT-02 \
  --role Backend \
  --task ORD-191
```

## Fluxo de trabalho recomendado

### 1. Consultar o estado

```bash
agent-memory status
```

ou:

```bash
agent-memory memory
```

### 2. Anunciar intenção

```bash
agent-memory intent \
  --agent AGENT-01 \
  --task AUTH-184 \
  --pointer "src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)" \
  --message "Adicionar validação de expiração do refresh token" \
  --reason "Tokens expirados ainda estão sendo aceitos"
```

### 3. Registrar alteração

```bash
agent-memory changed \
  --agent AGENT-01 \
  --pointer "src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)" \
  --message "Validação de expiresAt adicionada; token expirado agora é rejeitado"
```

### 4. Registrar teste

```bash
agent-memory testing \
  --agent AGENT-01 \
  --pointer "tests/Auth/TokenServiceTests.cs::ExpiredRefreshToken_ShouldFail()" \
  --message "Teste de regressão criado e executado com sucesso"
```

### 5. Finalizar

```bash
agent-memory done \
  --agent AGENT-01 \
  --message "AUTH-184 concluída; validação e testes passando"
```

## Ciclo de vida do agente

### Formato do id

Um id pode conter letras, dígitos, ponto, traço e sublinhado, com pelo menos uma letra ou dígito. Qualquer outra coisa é **recusada**, não corrigida.

Isso é deliberado: o id vira nome de arquivo. Se `AGENT/01` fosse sanitizado para `AGENT-01`, os dois passariam a compartilhar estado, histórico e caixa de entrada, e `unregister("AGENT/01")` apagaria o registro do `AGENT-01`. Recusar é a única forma de garantir que os dados de um agente sejam dele.

Ids são exclusivos: registrar um id que já existe falha, para que dois agentes diferentes não passem a compartilhar estado por acidente.

Quando o processo de um agente reinicia, use `--force` para abrir uma sessão nova preservando o histórico:

```bash
agent-memory register --agent AGENT-01 --force
```

Quando um agente sai de vez, remova-o do painel:

```bash
agent-memory unregister --agent AGENT-01
```

O `unregister` apaga apenas o estado. O histórico continua como trilha de auditoria, e o journal recebe um evento `UNREGISTERED`. Se o mesmo id for registrado de novo depois, o histórico anterior é mantido e a nova sessão entra abaixo de um separador: o arquivo nunca é sobrescrito.

## Journal de eventos

```bash
agent-memory log --limit 20
agent-memory log --agent AGENT-01
agent-memory log --json
```

## Compactação

### Automática

O journal é arquivado sozinho ao passar de `autoCompactAfterEvents` (padrão 5000), mantendo a metade mais recente:

```bash
agent-memory config --auto-compact 5000   # 0 desliga
```

A compactação também mantém as escritas rápidas. Toda escrita regenera o painel, e regenerar lê o journal inteiro, então o journal em crescimento encarece **toda escrita de todo agente**. Medido: sem compactação, a latência por escrita passou de 6,8 ms (2 mil eventos) para 12,7 ms (40 mil) e continuava subindo; com ela ligada, fica em ~6 ms independentemente do volume acumulado, porque o journal vivo estabiliza.

O gatilho é gratuito: a regeneração do painel já leu o journal, então o tamanho vem junto, sem uma segunda leitura. Vários agentes podem disparar ao mesmo tempo: o arquivamento é idempotente sob lock, então o primeiro corta e os demais não encontram nada a fazer.

### Manual

O `compact` arquiva o excedente em vez de descartar:

```bash
agent-memory compact --keep 500 --dry-run
agent-memory compact --keep 500
agent-memory compact --keep 500 --history
```

- os eventos além dos `--keep` mais recentes vão para `.agents/events/archive/`;
- com `--history`, cada `history/AGENT-X.md` vai para `.agents/history/archive/` e um arquivo novo é aberto apontando para o arquivado;
- cada caixa de entrada é reduzida a `--keep` mensagens, mas **somente as já lidas são descartadas**: uma mensagem que o destinatário ainda não viu nunca é removida, mesmo que isso deixe a caixa acima do limite;
- `--dry-run` mostra o que seria feito sem escrever nada.

## Espera por outro agente

```bash
agent-memory waiting \
  --agent AGENT-03 \
  --for AGENT-02 \
  --pointer "src/Payments/RefundService.cs::RefundService.CreateRefund()" \
  --message "Aguardando CancelAsync() ser concluído antes de integrar reembolso"
```

Isso **entrega uma mensagem na caixa do AGENT-02**. Declarar uma dependência sem avisar quem bloqueia só funcionaria se o outro agente lesse o painel por acaso.

Repetir a mesma espera não reenvia o aviso; mudar o ponteiro sim, porque é informação nova.

## Mensagens entre agentes

```bash
agent-memory send \
  --from AGENT-02 \
  --to AGENT-03 \
  --message "CancelAsync concluído, pode integrar" \
  --pointer "src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)"

agent-memory inbox --agent AGENT-03            # não lidas, e marca como lidas
agent-memory inbox --agent AGENT-03 --peek     # lê sem marcar
agent-memory inbox --agent AGENT-03 --all      # caixa inteira
```

Cada destinatário tem uma fila append-only em `.agents/inbox/`, com um cursor separado registrando a última mensagem confirmada; o log de mensagens nunca é reescrito.

A contagem de não lidas aparece onde o agente já olha, e não só em quem roda `inbox`: na coluna `INBOX` do `status`, no `memory_status` do MCP e no painel. Uma caixa de entrada que exige lembrar de consultar não seria lida.

Entrega para um agente não registrado é recusada. Uma espera por um agente inexistente continua sendo registrada, só não tem para onde entregar.

## Heartbeat

```bash
agent-memory heartbeat --agent AGENT-01
```

Por padrão, um agente sem heartbeat/atividade por mais de 60 segundos aparece como `OFFLINE` no painel central. Isso pode ser alterado:

```bash
agent-memory config --stale 120
```

## Trava do terminal

Troca de branch e edição feita pelo terminal passam por fora dos ganchos de edição, então o
`setup claude` também instala os ganchos `pre-shell` e `post-shell` no Bash e no PowerShell. Eles
anotam em que checkout cada sessão trabalha (seguindo `cd`, `Set-Location` e `git -C`) e quais
arquivos os comandos dela gravaram.

Um comando git que mexe no checkout (`checkout`, `switch`, `stash`, `reset`, `restore`, `pull`,
`merge`, `rebase`, `clean`, `cherry-pick`, `revert`, `am`) ou que põe tudo num commit (`add -A`,
`add .`, `commit -a`) é recusado enquanto outra sessão trabalha ali e há mudanças recentes que esta
sessão não fez, ou logo depois de outra sessão mudar a branch. A mensagem lista os arquivos, a
idade de cada um e as sessões vistas no checkout.

Quando as mudanças são suas, termine o comando com `# asm-ok: <motivo>`: ele passa e o motivo fica
guardado. `agent-memory guard-log` lista cada bloqueio e cada asm-ok, e é assim que o
[LESSONS.md](LESSONS.md) aprende onde a trava errou. `guardMinutes` no `.agents/config.json` define a
janela (padrão 30; 0 desliga), e `primeRules` troca as regras do resumo do começo da sessão.
`setup claude --hooks-only` não instala o servidor MCP.

Uma sessão que fecha sem SessionEnd (janela do editor fechada, travamento) ficaria no painel para
sempre. Quando uma sessão começa, as sessões caladas há mais de `forgetOfflineAfterHours` (padrão
24; 0 guarda todas) que não seguram tarefa nem reserva são esquecidas, no máximo uma vez por hora;
o histórico delas fica. `agent-memory forget-idle` faz essa limpeza na hora.

## Detecção de conflito

Se `AGENT-01` estiver trabalhando em:

```text
src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)
```

e `AGENT-05` anunciar uma intenção sobre o mesmo símbolo, o comando registra a ação, mas também exibe um aviso:

```text
WARNING: 1 active overlap(s) detected:
- AGENT-01 [WORKING] EXACT src/Orders/OrderService.cs -> OrderService.CancelAsync(Guid orderId)
```

O objetivo é **consciência compartilhada**, não uma trava rígida.

O aviso na CLI cobre quem está escrevendo naquele momento. Para ver todas as sobreposições ativas do projeto de uma vez, use o dashboard ou `GET /api/snapshot`.

## Fila de trabalho, runner e agendamento

Uma mensagem se perde se ninguém ler; uma **tarefa** fica na fila até alguém reivindicar e concluir. É a forma de delegar trabalho que **sobrevive à sessão**, inclusive entre ferramentas diferentes (Claude Code, Codex, Cursor) no mesmo repositório.

```bash
agent-memory task create --agent AGENT-01 --title "Documentar parseArgs" \
  --detail "Explicar a nova ordem de flags" --pointer "README.md"
agent-memory task create --agent AGENT-01 --title "Revisar auth" --for AGENT-02

agent-memory task list [--status OPEN] [--json]
agent-memory task claim --agent AGENT-02
agent-memory task done --id T-XXXX --message "README atualizado"
agent-memory task fail --id T-XXXX --message "faltou credencial"
```

Uma tarefa com `--for` só pode ser reivindicada pelo agente indicado, e chega também na caixa de entrada dele. Ao terminar, quem pediu recebe o resultado, inclusive quando falha.

### Quem faz e quem confere

`--review-by` separa quem executa de quem julga. A revisão é criada **junto** com o trabalho e fica bloqueada até ele terminar, então nenhum trabalho fecha sozinho:

```bash
agent-memory task create --agent LEAD --for DEV --review-by QA \
  --title "Implementar mediana(lista)" --detail "..."
```

Se a revisão reprovar, o trabalho volta para a fila com a objeção anexada ao `detail` (quem repegar começa da objeção, não do zero) e **uma nova revisão é enfileirada** para a próxima rodada. O portão não abre depois da primeira rejeição.

Quando qualquer agente capaz pode conferir, use `--review` para deixar a revisão aberta. Para trabalho caro de errar, `--reviewers N` cria um painel aberto de 1 a 9 revisores e decide por maioria:

```bash
agent-memory task create --agent LEAD --for DEV --reviewers 3 \
  --title "Migrar cobrança" --detail "Precisa de maioria antes de fechar"
```

Cada assento do painel precisa ser reivindicado por um agente diferente, e o executor nunca recebe a revisão do próprio trabalho. Se a maioria reprovar, os assentos restantes são cancelados e o trabalho volta para a fila; se um painel par empatar, o resultado conta como não aprovado.

`maxReviewRounds` (padrão 3) impede que executor e revisor que não se entendem troquem rejeições para sempre: passado o limite o trabalho falha para decisão humana.

Um revisor que **morre** (limite de sessão, rede, crash) não conta como reprovação: como o veredito veio do código de saída e não do agente, a revisão volta para a fila em vez de devolver trabalho correto.

### Dividir uma demanda e juntar de volta

`--depends-on` mantém uma tarefa fora da fila até que **todas** as suas dependências estejam `DONE`. É o que permite quebrar uma demanda em partes isoladas, rodá-las em paralelo, e ter uma tarefa que só começa quando o conjunto chegou:

```bash
# duas partes independentes, uma por agente
# --json devolve a tarefa inteira; o id é o que --depends-on precisa
id() { node -pe "JSON.parse(require('fs').readFileSync(0)).id"; }
A=$(agent-memory task create --agent LEAD --for W1 --title "parte A" --json | id)
B=$(agent-memory task create --agent LEAD --for W2 --title "parte B" --json | id)

# a síntese só aparece na fila quando A e B terminarem
agent-memory task create --agent LEAD --for REV --depends-on "$A,$B" \
  --title "Conferir o conjunto"
```

Quem reivindica a síntese recebe **os resultados das partes junto com o claim**; sem isso o agente receberia a pergunta com as respostas escondidas. Uma parte que falha mantém a síntese bloqueada: não há o que sintetizar de trabalho que não aconteceu.

Um `--depends-on` para um id inexistente é recusado na criação: ele nunca ficaria `DONE`, então a tarefa esperaria para sempre parecendo saudável na listagem.

### Runner

O runner reivindica tarefas e executa um comando por tarefa:

```bash
agent-memory run --agent AGENT-03 --exec "meu-script.sh" --once
agent-memory run --agent AGENT-03 --exec "claude -p \"$AGENT_TASK_DETAIL\""   # loop contínuo
```

**O conteúdo da tarefa nunca entra na string do comando.** Título, detalhe e ponteiro chegam por variáveis de ambiente:

```text
AGENT_ID  AGENT_MEMORY_ROOT  AGENT_TASK_ID  AGENT_TASK_TITLE
AGENT_TASK_DETAIL  AGENT_TASK_POINTER  AGENT_TASK_POINTER_FILE
AGENT_TASK_DEPTH  AGENT_TASK_ATTEMPT
```

O motivo é direto: o título é escrito por outro agente. Interpolá-lo no comando deixaria texto enfileirado virar código. Apenas `{{task_id}}` e `{{task_depth}}` são substituídos no comando, porque têm charset validado e não podem carregar sintaxe de shell, o que também evita a armadilha de escrever `$AGENT_TASK_ID` num comando que roda sob `cmd.exe` no Windows.

O comando roda com `cwd` na raiz do projeto, então use `--root .` ao chamar a própria CLI de dentro dele.

Exit 0 conclui a tarefa; qualquer outro código a marca como `FAILED`, guardando a saída. Um comando travado é morto por `--timeout` (padrão: a duração do claim), **junto com toda a árvore de processos**: matar só o shell deixaria o comando real vivo como neto.

### Executores prontos

Escrever o executor do zero é o passo mais chato. O projeto traz dois:

```bash
# CLI de agente que le stdin (claude -p e afins)
TASK_AGENT_CMD="claude -p" \
  agent-memory run --agent WORKER --exec "node examples/task-agent.mjs"

# modelo local via API do Ollama
agent-memory run --agent WORKER --exec "node examples/task-agent-ollama.mjs"
```

Ambos leem a tarefa do ambiente, escrevem o entregável em `outputs/<id>.md` e saem com 0 ou 1, que é o que a fila usa para marcar `DONE` ou `FAILED`.

O `task-agent.mjs` entrega o prompt pelo **stdin** do agente, não por argumento: título e detalhe são escritos por outro agente, e stdin não tem regras de quoting nem metacaracteres para atrapalhar. Ele também aceita `TASK_AGENT_DELEGATE=1`, e aí o agente decide se divide a tarefa e enfileira filhas com `--parent`; a profundidade é imposta pela fila, não pela boa vontade do modelo.

> Um CLI que **anima a saída** (spinner, redesenho de linha) não sobrevive a um pipe: o texto capturado vem com pedaços de linhas meio desenhadas. Foi por isso que a versão do Ollama usa a API HTTP em vez de `ollama run`. Se o seu agente tiver modo não-interativo ou API, prefira.

### Agendamento

```bash
agent-memory schedule create --agent AGENT-01 --cron "0 9 * * 1-5" \
  --title "Varredura diaria de dependencias"
agent-memory schedule list
agent-memory scheduler --interval 30       # daemon
agent-memory scheduler --once              # uma passada, para Task Scheduler/cron do SO
```

Cron de 5 campos com `*`, `n`, `a-b`, `a,b,c` e passos. Quando ambos os campos de dia estão restritos, basta um casar (comportamento padrão do cron). Vários schedulers podem rodar juntos: a varredura inteira é serializada e o `nextRunAt` é reavaliado dentro do lock, então um horário nunca dispara duas vezes.

### Tarefas fechadas vão para o arquivo

Quando há mais de `maxClosedTasks` tarefas fechadas (padrão 200) em `.agents/tasks/`, as mais
antigas vão para `.agents/tasks/archive/`, e a fila continua rápida por mais tempo que o projeto
dure. Uma tarefa fechada que trabalho aberto ainda cita (uma dependência, o trabalho sob revisão
aberta) fica. Tarefas arquivadas continuam legíveis pelo id, continuam valendo como dependência e
aparecem em `task list --all` ou ao pedir um status fechado (`task list --status DONE`).

### Limites contra spawn descontrolado

Um agente que cria tarefas pode criar um agente que cria tarefas. Toda tarefa criada **durante a execução de outra** herda profundidade + 1, e passar de `maxTaskDepth` (padrão 3) é recusado:

```text
T-...52278 | DONE   | depth 0 | auditoria de dependencias
T-...IO9739 | DONE   | depth 1 | corrigir o que a auditoria achou
T-...NF910 | DONE   | depth 2 | corrigir o que a auditoria achou
T-...V8CFF9 | FAILED | depth 3 | Task depth limit reached (3)
```

O servidor MCP fecha esse ciclo sozinho: quando iniciado por um runner, ele lê `AGENT_TASK_ID` do próprio ambiente e usa como pai de qualquer tarefa criada. O modelo não precisa saber que existe profundidade.

Um claim expira depois de `taskClaimSeconds` (padrão 900). Se o runner morrer no meio, a tarefa volta para a fila com o número de tentativas incrementado, em vez de ficar presa.

## Watcher de Git

O restante do sistema confia no autorrelato do agente. O watcher lê o working tree e compara com o que foi declarado:

```bash
agent-memory watch                 # acompanha continuamente
agent-memory watch --interval 5
agent-memory watch --once          # uma passada e sai
agent-memory watch --dry-run       # reporta sem gravar nada
```

Cada arquivo alterado é atribuído ao agente que aponta para ele: pelo ponteiro atual ou, se o agente já seguiu adiante, pelo journal recente:

```text
AGENT-01               src/Auth.cs (modified +2/-0)
UNDECLARED             src/Orders.cs (modified +1/-0)
AMBIGUOUS(A-01|A-02)   src/Shared.cs (modified +3/-1)
```

A atribuição é conservadora de propósito: só existe dono quando **exatamente um** agente reivindica o arquivo. Com zero ou vários, o watcher reporta `UNDECLARED`/`AMBIGUOUS` em vez de chutar.

Os achados entram no journal como eventos `OBSERVED`. Duas garantias importantes:

- o watcher **nunca altera o estado de um agente**: uma observação não sobrescreve o que o agente declarou estar fazendo;
- alterações sem dono não entram no histórico de ninguém, para que o histórico individual continue sendo o registro do que aquele agente de fato declarou.

O diretório `.agents/` é sempre ignorado.

Em modo contínuo, as alterações já existentes na largada viram baseline e não são reportadas. Com `--once` não há baseline: tudo que estiver no working tree é avaliado, e o comando **sai com código 1 se houver alterações não declaradas**, o que serve como verificação em CI ou em hook de pre-commit.

## Dashboard local

```bash
agent-memory serve
```

Abra:

```text
http://127.0.0.1:4317
```

O painel é atualizado por push via SSE: o servidor observa o `.agents/` e envia um snapshot novo **apenas quando algo muda**. Não há recarregamento de página, então o scroll, o foco e o filtro são preservados, e um projeto parado não gera tráfego.

O painel mostra:

- os agentes, com status efetivo (`OFFLINE` quando o heartbeat vence), demanda, ação atual e ponteiro;
- um alerta com **todas** as sobreposições ativas do painel, e as linhas envolvidas destacadas; antes o conflito só aparecia para quem estava escrevendo naquele instante;
- o feed de atividade recente;
- um filtro por agente, demanda, arquivo ou símbolo.

Endpoints:

```text
GET /events         stream SSE de snapshots
GET /api/snapshot   mesmo payload, uma vez
GET /api/status     estado dos agentes (formato original)
GET /api/memory     SHARED_MEMORY.md
```

## Servidor MCP

Em vez de fazer o agente chamar a CLI por shell, exponha a memória como ferramentas nativas via MCP (stdio):

```bash
agent-memory mcp --root /caminho/meu-backend
```

Sem `--root`, o diretório atual é usado. O `.agents/` precisa já existir (`agent-memory init`); as ferramentas recusam escrever antes disso em vez de criar um `.agents/` no lugar errado.

### Identidade fixa (recomendado)

Passe `--agent` para amarrar o servidor a um id:

```bash
agent-memory mcp --root /caminho/meu-backend --agent AGENT-01
```

Com isso:

- o agente é registrado (ou reanexado) na largada, sem o modelo precisar chamar `memory_register`;
- o parâmetro `agent` **some de todas as ferramentas**: `memory_record` passa a exigir só `type` e `message`;
- o id não pode ser forjado: passar `agent` de outro na chamada não redireciona a escrita.

Sem isso, cada agente teria que inventar e lembrar o próprio id em toda chamada, e dois deles escolhendo `AGENT-01` compartilhariam estado sem ninguém perceber.

### Configuração no cliente

A maioria dos clientes MCP (Claude Code, Codex, Cursor) usa o mesmo formato. Em `.mcp.json` na raiz do projeto, com **um id diferente por agente**:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "agent-memory",
      "args": ["mcp", "--root", "/caminho/meu-backend", "--agent", "AGENT-01"]
    }
  }
}
```

No Claude Code também é possível registrar pela CLI:

```bash
claude mcp add agent-memory -- agent-memory mcp --root /caminho/meu-backend --agent AGENT-01
```

### Rodando vários agentes

```bash
cd /caminho/meu-backend
agent-memory init --name "Meu Backend"
agent-memory serve            # painel em http://127.0.0.1:4317
```

Depois, cada agente sobe apontando para o mesmo repositório, mudando apenas o `--agent`: `AGENT-01`, `AGENT-02`, `AGENT-03`. Nada mais precisa ser coordenado: o `.agents/` é o ponto de encontro, e a detecção de sobreposição, as mensagens e o painel funcionam entre processos independentes.

### Ferramentas expostas

| Ferramenta | Uso |
| --- | --- |
| `memory_status` | Estado atual de todos os agentes. Aceita `pointer` para checar sobreposição **antes** de anunciar a intenção. |
| `memory_read` | `SHARED_MEMORY.md` completo. |
| `memory_read_pointer` | Lê **só o símbolo** que o ponteiro nomeia, não o arquivo inteiro. Ver [Ler pelo ponteiro](#ler-pelo-ponteiro). |
| `memory_register` | Registra o agente. Se o id já existe, reanexa em vez de falhar; seguro em reconexões. |
| `memory_record` | Um passo do ciclo, via `type`: `INTENT`, `READING`, `FOUND`, `CHANGED`, `CREATED`, `TESTING`, `WAITING`, `NOTE`, `DONE`. Retorna as sobreposições detectadas. |
| `memory_task_create` | Enfileira trabalho durável para outro agente. |
| `memory_task_list` | Lista a fila. |
| `memory_task_claim` | Reivindica a tarefa mais antiga disponível. |
| `memory_task_finish` | Fecha a tarefa com DONE, FAILED ou CANCELLED. |
| `memory_send` | Envia mensagem para a caixa de outro agente. |
| `memory_inbox` | Lê as mensagens do agente. Aceita `peek` e `all`. |
| `memory_heartbeat` | Atualiza a presença em trechos longos sem registro. |
| `memory_log` | Últimos eventos do journal global, opcionalmente filtrados por agente. |
| `memory_prime` | Briefing de início de sessão: regras, fatos do projeto, quem está ativo, arquivos reservados, trabalho pronto, mensagens não lidas. |
| `memory_task_ready` | Tarefas que o agente pode pegar agora, as mais urgentes primeiro. |
| `memory_task_show` | Uma tarefa com suas revisões, vereditos e cada evento do journal que a cita. |
| `memory_reserve` | Reserva arquivos, pastas ou globs, exclusivo ou compartilhado, tudo ou nada, por tempo limitado. |
| `memory_release` | Libera as reservas do agente. |
| `memory_reservations` | Lista os arquivos reservados agora. |
| `memory_remember` | Guarda um fato curto que toda sessão recebe. |
| `memory_symbols` | Lista o que um arquivo declara, com as linhas, sem lê-lo inteiro. |
| `memory_find_symbol` | Acha onde um símbolo é declarado no projeto; `Tipo.membro` restringe. |
| `memory_references` | Acha as linhas que usam um símbolo, fora de strings e comentários. |
| `memory_replace_symbol` | Troca uma função, método, classe ou propriedade no lugar, sob trava, recusando código que quebra a sintaxe do arquivo. |
| `memory_insert_symbol` | Insere código novo logo depois ou antes de um símbolo, com a mesma segurança. |
| `memory_rename` | Renomeia um símbolo no projeto: primeiro o plano, `apply` para gravar. |

O handshake `initialize` já devolve o protocolo (`READ -> INTENT -> CODE -> RESULT`) no campo `instructions`, então o agente recebe as regras sem precisar do `AGENT_PROTOCOL.md` no system prompt.

O transporte é JSON-RPC 2.0 sobre stdio, implementado direto no projeto, sem dependências de runtime. `stdout` pertence ao protocolo; diagnósticos vão para `stderr`.

## Formato de ponteiro

```text
arquivo::símbolo::parâmetro
```

Exemplos:

```text
src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)
src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)::orderId
src/Customers/CustomerRepository.cs
```

O sistema normaliza barras e compara arquivo + símbolo para detectar sobreposição.

### Ler pelo ponteiro

O ponteiro não serve só para detectar conflito: `memory_read_pointer` devolve **o símbolo, não o arquivo**, com comentário de doc e as linhas de onde veio.

```text
memory_read_pointer  pointer="src/core/config.ts::DEFAULT_CONFIG"

src/core/config.ts:6-16 (DEFAULT_CONFIG)

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  ...
};
```

Medido em 213 rodadas com 10 modelos grátis, sobre código real em TypeScript, C# e Python: nas perguntas que as duas formas responderam, ler pelo ponteiro acertou o mesmo tanto e gastou **66% menos tokens**. No plano grátis do Groq, o arquivo inteiro nem coube em 30 de 107 rodadas; pelo ponteiro, o mesmo modelo respondeu. O gargalo era a leitura, não o modelo.

A extração é heurística, não parser: chaves balanceadas para a família C, recuo para Python, e **nada** em vez de um palpite quando o símbolo não é encontrado. Um recorte confiante da função errada é pior que recorte nenhum. Medida contra os próprios compiladores (TypeScript, `ast` do Python e Roslyn do C#) em 9.400 declarações, ela devolve exatamente a declaração pedida em 99,4% dos casos em C#, 99,3% em TypeScript e 98,8% em Python. Um membro é procurado dentro do seu tipo (`arquivo::Tipo.membro`).

Leituras são resolvidas sob a raiz do projeto e comparadas depois de resolvidas: o ponteiro vem de um modelo, e um modelo mal instruído pede `../../.ssh/id_rsa`.

O mesmo recorte está disponível para executores locais como a ferramenta `read_pointer` em `examples/task-agent-local.mjs`.

## Protocolo para colocar no prompt de cada agente

Use o conteúdo de `AGENT_PROTOCOL.md` no system prompt/instructions do agente. A regra principal é:

> READ -> INTENT -> CODE -> RESULT -> READ

Isso mantém os agentes conscientes do que os outros estão fazendo.

Via MCP isso é opcional: o servidor já entrega o protocolo no `initialize`, e o `AGENT_PROTOCOL.md` traz a tabela de equivalência entre comandos e ferramentas.

## Comandos

```text
init        Inicializa .agents/
register    Registra um agente e abre seu histórico (--force reinicia a sessão)
unregister  Remove o agente do painel, mantendo o histórico
status      Mostra estado resumido dos agentes
memory      Imprime SHARED_MEMORY.md
log         Lista os eventos mais recentes do journal
send        Envia mensagem para a caixa de outro agente
inbox       Lê as mensagens endereçadas ao agente
heartbeat   Atualiza presença do agente
intent      Declara o que será feito antes da alteração
reading     Registra leitura/análise de código
found       Registra descoberta relevante
changed     Registra código alterado
created     Registra código/arquivo criado
testing     Registra testes em andamento/concluídos
waiting     Registra dependência/espera
note        Registra observação operacional
done        Finaliza a demanda/ação
task        Enfileira, lista, reivindica e conclui trabalho
schedule    Cria e lista agendamentos cron
run         Runner: reivindica tarefas e executa um comando por tarefa
scheduler   Materializa tarefas dos agendamentos vencidos
config      Consulta/altera configuração
compact     Arquiva journal e históricos antigos
watch       Compara o working tree do Git com o que foi declarado
serve       Abre dashboard local
mcp         Servidor MCP em stdio
prime       Briefing de início de sessão
reserve     Reserva arquivos, pastas ou globs (release, reservations)
remember    Guarda um fato do projeto (facts, forget)
symbols     Lista o que um arquivo declara
find        Acha onde um símbolo é declarado
refs        Acha onde um símbolo é usado
rename      Renomeia um símbolo no projeto (--apply para gravar)
setup       Instala ganchos e MCP do Claude Code (setup claude) ou a guarda do git (setup git)
hook        Ponto de entrada que os ganchos chamam
hub         Compartilha esta memória com outras máquinas por HTTP
```

## Concorrência

Cada agente roda no seu próprio processo, escrevendo no mesmo `.agents/`.

- Cada `state/AGENT-X.json` é escrito atomicamente.
- Cada histórico individual possui lock próprio.
- O `events.jsonl` possui lock global curto somente no append.
- `SHARED_MEMORY.md` é regenerado por um processo de cada vez e escrito atomicamente. Uma escrita que
  o encontra sendo regenerado deixa uma marca e segue; o processo que está regenerando refaz no fim,
  e uma leitura refaz antes quando há marca.
- Os agentes nunca precisam editar o arquivo central manualmente.
- Um lock deixado para trás por um processo morto é recuperado após 30 segundos, em vez de travar o `.agents/` até alguém apagar o arquivo na mão.
- Contenção de lock é tratada como espera, não como erro. No Windows, um arquivo em *pending-delete* ou aberto por outro leitor retorna `EPERM`/`EACCES`/`EBUSY` em vez de `EEXIST`; tratar isso como falha derruba o agente exatamente sob carga. O `rename` da escrita atômica tem a mesma proteção, e o arquivo temporário é removido se ainda assim falhar.
- **A regeneração do painel nunca derruba a escrita que a precede.** `state/` e `events.jsonl` são gravados antes e são a fonte da verdade; o `SHARED_MEMORY.md` é derivado. Se o lock do painel estiver muito disputado, a escrita permanece durável e o próximo agente regenera a partir do disco.

Medido em processos concorrentes de verdade, do zero até 40 agentes × 25 atividades (1.040 eventos): nenhum evento perdido, nenhum arquivo corrompido, nenhum histórico contaminado, nenhum lock preso, e o painel permanecendo em dia. A vazão sob 40 processos simultâneos é de cerca de 120 escritas/s (60 antes da 1.4.0, quando toda escrita esperava a vez de regenerar o painel).

Para referência, `status` e o dashboard leem `state/` diretamente, então mostram o estado corrente mesmo que o `SHARED_MEMORY.md` esteja momentaneamente atrás.

## Testes

```bash
npm test
```

## Exemplo automático

```bash
npm run example
```

O exemplo cria um projeto temporário, registra três agentes e simula conflito e dependência.

## Evoluções possíveis

- plugin de VS Code;
- referência por AST/LSP em vez de somente strings semânticas;
- detecção de dependências entre símbolos;
- integração com worktrees e branches.

## Licença

MIT.
