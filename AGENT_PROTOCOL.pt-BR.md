# Agent Shared Memory Protocol

[English](AGENT_PROTOCOL.md)

Você é um agente de programação trabalhando simultaneamente com outros agentes no mesmo repositório.

## Regra obrigatória

Siga continuamente o ciclo:

```text
READ -> INTENT -> CODE -> RESULT -> READ
```

### READ

Antes de uma alteração relevante, consulte:

```bash
agent-memory status
```

ou:

```bash
agent-memory memory
```

Observe especialmente agentes trabalhando no mesmo arquivo, classe, método, contrato ou dependência.

### INTENT

Antes de modificar código, registre uma descrição curta e precisa (idealmente 1-3 linhas):

```bash
agent-memory intent \
  --agent <SEU_ID> \
  --task <DEMANDA> \
  --pointer "arquivo::simbolo::parametro" \
  --message "o que será alterado" \
  --reason "por que será alterado"
```

Nunca anuncie uma intenção genérica como "melhorar backend". Diga exatamente o componente e a alteração planejada.

### CODE

Faça somente a alteração anunciada. Se o plano mudar materialmente, publique um novo `intent` antes da nova alteração.

### RESULT

Imediatamente após a alteração, registre o resultado usando `changed`, `created`, `testing`, `found`, `waiting` ou `done`.

Exemplo:

```bash
agent-memory changed \
  --agent <SEU_ID> \
  --pointer "arquivo::simbolo" \
  --message "resultado exato e resumido"
```

### CONFLITOS

Se o comando indicar sobreposição com outro agente:

1. leia a memória desse agente;
2. não desfaça mudanças feitas por ele;
3. ajuste sua implementação para coexistir quando possível;
4. se depender dele, registre `waiting --for AGENT-X` — isso avisa o agente diretamente;
5. se a alteração ainda puder ser feita sem conflito semântico, prossiga e documente isso.

### HISTÓRICO

Nunca edite manualmente:

```text
.agents/SHARED_MEMORY.md
.agents/history/OUTRO-AGENTE.md
```

Seu histórico é gerenciado pelos comandos da ferramenta.

### PONTEIROS

Prefira:

```text
src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)
```

Evite números de linha, pois mudam durante edições concorrentes.

### MENSAGENS

Outros agentes podem lhe enviar mensagens, e uma dependência declarada com `waiting --for` chega diretamente na sua caixa.

O `status` mostra quantas mensagens você tem sem ler. Ao ver mensagens não lidas, leia antes de continuar:

```bash
agent-memory inbox --agent <SEU_ID>
```

Para avisar outro agente sobre algo que afeta o trabalho dele:

```bash
agent-memory send \
  --from <SEU_ID> \
  --to AGENT-02 \
  --message "resultado exato e resumido" \
  --pointer "arquivo::simbolo"
```

Não envie um aviso manual duplicando um `waiting` — a dependência já notifica sozinha.

### HEARTBEAT

Em sessões longas sem atividade registrada, execute periodicamente:

```bash
agent-memory heartbeat --agent <SEU_ID>
```

### ARQUIVOS E EDIÇÕES

- Reserve os arquivos que você vai mudar: `agent-memory reserve --agent <SEU_ID> src/auth/`
  (ou `memory_reserve`). Um arquivo que outro agente reservou é dele até ser liberado ou expirar;
  pegue outra tarefa ou peça a ele com `send`.
- Mude uma função, método ou classe com `memory_replace_symbol` em vez de regravar o arquivo. Ela
  relê o arquivo na hora de gravar, então as mudanças dos outros agentes ficam, e recusa uma
  mudança que quebraria a sintaxe do arquivo.
- Libere suas reservas quando terminar (`release`, ou `memory_release`).

## Via MCP

Se o servidor MCP estiver conectado, use as ferramentas em vez dos comandos de shell. O ciclo é o mesmo.

| Comando CLI | Ferramenta MCP |
| --- | --- |
| `status` | `memory_status` |
| `memory` | `memory_read` |
| `register` | `memory_register` |
| `intent`, `changed`, `created`, `testing`, `found`, `waiting`, `note`, `done` | `memory_record` com o `type` correspondente |
| `send` | `memory_send` |
| `inbox` | `memory_inbox` |
| `heartbeat` | `memory_heartbeat` |
| — | `memory_log` (journal global de eventos) |

Duas diferenças úteis no modo MCP:

- `memory_status` aceita `pointer`, permitindo checar sobreposição em um símbolo específico **antes** de anunciar a intenção;
- `memory_register` reanexa o agente se o id já existir, então pode ser chamado a cada reconexão.
