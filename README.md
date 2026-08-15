# Agent Shared Memory

Uma memória operacional compartilhada para vários agentes de IA trabalhando no mesmo repositório.

A proposta é simples: antes de uma alteração relevante, o agente anuncia **o que vai fazer**, **onde vai mexer** e **por quê**. Durante o trabalho, todos conseguem ver o estado atual dos demais. Depois da alteração, o agente registra o resultado no seu próprio histórico.

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

Ids são exclusivos: registrar um id que já existe falha, para que dois agentes diferentes não passem a compartilhar estado por acidente.

Quando o processo de um agente reinicia, use `--force` para abrir uma sessão nova preservando o histórico:

```bash
agent-memory register --agent AGENT-01 --force
```

Quando um agente sai de vez, remova-o do painel:

```bash
agent-memory unregister --agent AGENT-01
```

O `unregister` apaga apenas o estado. O histórico continua como trilha de auditoria, e o journal recebe um evento `UNREGISTERED`. Se o mesmo id for registrado de novo depois, o histórico anterior é mantido e a nova sessão entra abaixo de um separador — o arquivo nunca é sobrescrito.

## Journal de eventos

```bash
agent-memory log --limit 20
agent-memory log --agent AGENT-01
agent-memory log --json
```

## Compactação

Histórico e journal crescem indefinidamente. O `compact` arquiva o excedente em vez de descartar:

```bash
agent-memory compact --keep 500 --dry-run
agent-memory compact --keep 500
agent-memory compact --keep 500 --history
```

- os eventos além dos `--keep` mais recentes vão para `.agents/events/archive/`;
- com `--history`, cada `history/AGENT-X.md` vai para `.agents/history/archive/` e um arquivo novo é aberto apontando para o arquivado;
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

Cada destinatário tem uma fila append-only em `.agents/inbox/`, com um cursor separado registrando a última mensagem confirmada — o log de mensagens nunca é reescrito.

A contagem de não lidas aparece onde o agente já olha, e não só em quem roda `inbox`: na coluna `INBOX` do `status`, no `memory_status` do MCP e no painel. Uma caixa de entrada que exige lembrar de consultar não seria lida.

Entrega para um agente não registrado é recusada. Uma espera por um agente inexistente continua sendo registrada — só não tem para onde entregar.

## Heartbeat

```bash
agent-memory heartbeat --agent AGENT-01
```

Por padrão, um agente sem heartbeat/atividade por mais de 60 segundos aparece como `OFFLINE` no painel central. Isso pode ser alterado:

```bash
agent-memory config --stale 120
```

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

O objetivo é **consciência compartilhada**, não locking autoritário.

O aviso na CLI cobre quem está escrevendo naquele momento. Para ver todas as sobreposições ativas do projeto de uma vez, use o dashboard ou `GET /api/snapshot`.

## Watcher de Git

O restante do sistema confia no autorrelato do agente. O watcher lê o working tree e compara com o que foi declarado:

```bash
agent-memory watch                 # acompanha continuamente
agent-memory watch --interval 5
agent-memory watch --once          # uma passada e sai
agent-memory watch --dry-run       # reporta sem gravar nada
```

Cada arquivo alterado é atribuído ao agente que aponta para ele — pelo ponteiro atual ou, se o agente já seguiu adiante, pelo journal recente:

```text
AGENT-01               src/Auth.cs (modified +2/-0)
UNDECLARED             src/Orders.cs (modified +1/-0)
AMBIGUOUS(A-01|A-02)   src/Shared.cs (modified +3/-1)
```

A atribuição é conservadora de propósito: só existe dono quando **exatamente um** agente reivindica o arquivo. Com zero ou vários, o watcher reporta `UNDECLARED`/`AMBIGUOUS` em vez de chutar.

Os achados entram no journal como eventos `OBSERVED`. Duas garantias importantes:

- o watcher **nunca altera o estado de um agente** — uma observação não sobrescreve o que o agente declarou estar fazendo;
- alterações sem dono não entram no histórico de ninguém, para que o histórico individual continue sendo o registro do que aquele agente de fato declarou.

O diretório `.agents/` é sempre ignorado.

Em modo contínuo, as alterações já existentes na largada viram baseline e não são reportadas. Com `--once` não há baseline: tudo que estiver no working tree é avaliado, e o comando **sai com código 1 se houver alterações não declaradas** — o que serve como verificação em CI ou em hook de pre-commit.

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
- um alerta com **todas** as sobreposições ativas do painel, e as linhas envolvidas destacadas — antes o conflito só aparecia para quem estava escrevendo naquele instante;
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
- o parâmetro `agent` **some de todas as ferramentas** — `memory_record` passa a exigir só `type` e `message`;
- o id não pode ser forjado: passar `agent` de outro na chamada não redireciona a escrita.

Sem isso, cada agente teria que inventar e lembrar o próprio id em toda chamada — e dois deles escolhendo `AGENT-01` compartilhariam estado sem ninguém perceber.

### Configuração no cliente

A maioria dos clientes MCP (Claude Code, Codex, Cursor) usa o mesmo formato. Em `.mcp.json` na raiz do projeto — **um id diferente por agente**:

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

Depois, cada agente sobe apontando para o mesmo repositório, mudando apenas o `--agent`: `AGENT-01`, `AGENT-02`, `AGENT-03`. Nada mais precisa ser coordenado — o `.agents/` é o ponto de encontro, e a detecção de sobreposição, as mensagens e o painel funcionam entre processos independentes.

### Ferramentas expostas

| Ferramenta | Uso |
| --- | --- |
| `memory_status` | Estado atual de todos os agentes. Aceita `pointer` para checar sobreposição **antes** de anunciar a intenção. |
| `memory_read` | `SHARED_MEMORY.md` completo. |
| `memory_register` | Registra o agente. Se o id já existe, reanexa em vez de falhar — seguro em reconexões. |
| `memory_record` | Um passo do ciclo, via `type`: `INTENT`, `READING`, `FOUND`, `CHANGED`, `CREATED`, `TESTING`, `WAITING`, `NOTE`, `DONE`. Retorna as sobreposições detectadas. |
| `memory_send` | Envia mensagem para a caixa de outro agente. |
| `memory_inbox` | Lê as mensagens do agente. Aceita `peek` e `all`. |
| `memory_heartbeat` | Atualiza a presença em trechos longos sem registro. |
| `memory_log` | Últimos eventos do journal global, opcionalmente filtrados por agente. |

O handshake `initialize` já devolve o protocolo (`READ -> INTENT -> CODE -> RESULT`) no campo `instructions`, então o agente recebe as regras sem precisar do `AGENT_PROTOCOL.md` no system prompt.

O transporte é JSON-RPC 2.0 sobre stdio, implementado direto no projeto — sem dependências de runtime. `stdout` pertence ao protocolo; diagnósticos vão para `stderr`.

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
config      Consulta/altera configuração
compact     Arquiva journal e históricos antigos
watch       Compara o working tree do Git com o que foi declarado
serve       Abre dashboard local
mcp         Servidor MCP em stdio
```

## Concorrência

Cada agente roda no seu próprio processo, escrevendo no mesmo `.agents/`.

- Cada `state/AGENT-X.json` é escrito atomicamente.
- Cada histórico individual possui lock próprio.
- O `events.jsonl` possui lock global curto somente no append.
- `SHARED_MEMORY.md` é regenerado sob lock e escrito atomicamente.
- Os agentes nunca precisam editar o arquivo central manualmente.
- Um lock deixado para trás por um processo morto é recuperado após 30 segundos, em vez de travar o `.agents/` até alguém apagar o arquivo na mão.
- Contenção de lock é tratada como espera, não como erro. No Windows, um arquivo em *pending-delete* ou aberto por outro leitor retorna `EPERM`/`EACCES`/`EBUSY` em vez de `EEXIST`; tratar isso como falha derruba o agente exatamente sob carga. O `rename` da escrita atômica tem a mesma proteção, e o arquivo temporário é removido se ainda assim falhar.
- **A regeneração do painel nunca derruba a escrita que a precede.** `state/` e `events.jsonl` são gravados antes e são a fonte da verdade; o `SHARED_MEMORY.md` é derivado. Se o lock do painel estiver muito disputado, a escrita permanece durável e o próximo agente regenera a partir do disco.

Medido em processos concorrentes de verdade, do zero até 40 agentes × 25 atividades (1.040 eventos): nenhum evento perdido, nenhum arquivo corrompido, nenhum histórico contaminado, nenhum lock preso, e o painel permanecendo em dia. A vazão sob 40 processos simultâneos ficou em torno de 60 escritas/s — o `refreshSharedMemory` serializa no lock global, que é o teto de escala.

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
- compactação automática por limite, sem precisar chamar `compact`;
- integração com worktrees e branches.

## Licença

MIT.
