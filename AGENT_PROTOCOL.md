# Agent Shared Memory Protocol

[Português](AGENT_PROTOCOL.pt-BR.md)

You are a coding agent working concurrently with other agents in the same repository.

## Required Rule

Continuously follow this cycle:

```text
READ -> INTENT -> CODE -> RESULT -> READ
```

### READ

Before a meaningful change, check:

```bash
agent-memory status
```

or:

```bash
agent-memory memory
```

Pay special attention to agents working on the same file, class, method, contract or dependency.

### INTENT

Before editing code, record a short and precise description, ideally 1-3 lines:

```bash
agent-memory intent \
  --agent <YOUR_ID> \
  --task <TASK> \
  --pointer "file::symbol::parameter" \
  --message "what will change" \
  --reason "why it will change"
```

Never announce vague intent such as "improve backend". Name the exact component and planned change.

### CODE

Make only the change you announced. If the plan changes materially, publish a new `intent` before
the new change.

### RESULT

Immediately after the change, record the result with `changed`, `created`, `testing`, `found`,
`waiting` or `done`.

Example:

```bash
agent-memory changed \
  --agent <YOUR_ID> \
  --pointer "file::symbol" \
  --message "exact short result"
```

### CONFLICTS

If a command reports overlap with another agent:

1. read that agent's memory;
2. do not undo changes made by that agent;
3. adjust your implementation to coexist when possible;
4. if you depend on that agent, record `waiting --for AGENT-X`, which notifies it directly;
5. if your change can still be made without a semantic conflict, proceed and document that.

### HISTORY

Never edit these files manually:

```text
.agents/SHARED_MEMORY.md
.agents/history/OTHER-AGENT.md
```

Your own history is managed by the tool commands.

### POINTERS

Prefer semantic pointers:

```text
src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)
```

Avoid line numbers because they move during concurrent edits.

### MESSAGES

Other agents can send you messages, and a dependency declared with `waiting --for` arrives directly
in your inbox.

`status` shows how many unread messages you have. If you see unread messages, read them before
continuing:

```bash
agent-memory inbox --agent <YOUR_ID>
```

To notify another agent about something that affects its work:

```bash
agent-memory send \
  --from <YOUR_ID> \
  --to AGENT-02 \
  --message "exact short result" \
  --pointer "file::symbol"
```

Do not send a manual notice duplicating `waiting`; the dependency already notifies the target.

### HEARTBEAT

During long sessions with no recorded activity, periodically run:

```bash
agent-memory heartbeat --agent <YOUR_ID>
```

### FILES AND EDITS

- Reserve the files you are about to change: `agent-memory reserve --agent <YOUR_ID> src/auth/`
  (or `memory_reserve`). A file another agent reserved is theirs until it is released or expires;
  pick other work or ask them with `send`.
- Change one function, method or class with `memory_replace_symbol` instead of rewriting the
  file. It re-reads the file when it writes, so other agents' changes survive, and it refuses a
  change that would break the file's syntax.
- Release your reservations when you are done (`release`, or `memory_release`).

## MCP

If the MCP server is connected, use tools instead of shell commands. The cycle is the same.

| CLI command | MCP tool |
| --- | --- |
| `status` | `memory_status` |
| `memory` | `memory_read` |
| `register` | `memory_register` |
| `intent`, `changed`, `created`, `testing`, `found`, `waiting`, `note`, `done` | `memory_record` with the matching `type` |
| `send` | `memory_send` |
| `inbox` | `memory_inbox` |
| `heartbeat` | `memory_heartbeat` |
| - | `memory_log` |

Two MCP details are useful:

- `memory_status` accepts `pointer`, so you can check overlap on a specific symbol before declaring
  intent;
- `memory_register` reattaches the agent if the id already exists, so it can be called on every
  reconnection.
