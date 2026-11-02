import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';
import { buildSnapshot } from '../src/web/snapshot.js';
import { createMcpMethods } from '../src/mcp/server.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function withProject(
  fn: (service: AgentMemoryService, call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-msg-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Message Project');
    const methods = createMcpMethods(service);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;
    await fn(service, call, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a message lands in the recipient inbox and in the journal', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');

    await service.sendMessage({
      from: 'AGENT-01',
      to: 'AGENT-02',
      body: 'CancelAsync agora exige orderId nao nulo.',
      pointer: parsePointer('src/Orders.cs::OrderService.CancelAsync(Guid orderId)')
    });

    const inbox = await service.readInbox('AGENT-02', { markRead: false });
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].from, 'AGENT-01');
    assert.equal(inbox.messages[0].kind, 'direct');
    assert.match(inbox.messages[0].body, /CancelAsync/);

    // The sender's inbox stays empty: delivery is one-way.
    assert.deepEqual((await service.readInbox('AGENT-01', { markRead: false })).messages, []);

    const events = await service.store.recentActivities(5);
    assert.equal(events[0].type, 'MESSAGE');
    assert.equal(events[0].agentId, 'AGENT-01');
    assert.match(events[0].description, /-> AGENT-02:/);
  });
});

test('unread tracking advances only for what was read', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');

    await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: 'primeira' });
    await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: 'segunda' });
    assert.equal(await service.messages.unreadCount('AGENT-02'), 2);

    const peek = await service.readInbox('AGENT-02', { markRead: false });
    assert.equal(peek.unread.length, 2);
    assert.equal(await service.messages.unreadCount('AGENT-02'), 2, 'peeking must not acknowledge');

    const read = await service.readInbox('AGENT-02');
    assert.equal(read.unread.length, 2);
    assert.equal(await service.messages.unreadCount('AGENT-02'), 0);

    await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: 'terceira' });
    const after = await service.readInbox('AGENT-02', { markRead: false });
    assert.equal(after.unread.length, 1, 'only what arrived since is unread');
    assert.equal(after.unread[0].body, 'terceira');
    assert.equal(after.messages.length, 3, 'the full inbox is still there');
  });
});

test('declaring WAITING notifies the agent being waited on', async () => {
  await withProject(async service => {
    await service.register('AGENT-02');
    await service.register('AGENT-03');

    await service.activity({
      agentId: 'AGENT-03',
      type: 'WAITING',
      description: 'Aguardando CancelAsync antes de integrar reembolso.',
      waitingFor: 'AGENT-02',
      pointer: parsePointer('src/Payments.cs::RefundService.CreateRefund()')
    });

    const inbox = await service.readInbox('AGENT-02', { markRead: false });
    assert.equal(inbox.unread.length, 1);
    assert.equal(inbox.unread[0].kind, 'waiting');
    assert.equal(inbox.unread[0].from, 'AGENT-03');
    assert.match(inbox.unread[0].body, /AGENT-03 is waiting for you/);
    assert.match(inbox.unread[0].body, /RefundService\.CreateRefund/);
  });
});

test('re-declaring the same wait does not send a second notice', async () => {
  await withProject(async service => {
    await service.register('AGENT-02');
    await service.register('AGENT-03');
    const pointer = parsePointer('src/Payments.cs::RefundService.CreateRefund()');

    await service.activity({ agentId: 'AGENT-03', type: 'WAITING', description: 'aguardando', waitingFor: 'AGENT-02', pointer });
    await service.activity({ agentId: 'AGENT-03', type: 'WAITING', description: 'aguardando', waitingFor: 'AGENT-02', pointer });
    assert.equal(await service.messages.unreadCount('AGENT-02'), 1, 'a repeated wait is not re-sent');

    // Moving the wait to a different pointer is new information and must notify again.
    await service.activity({
      agentId: 'AGENT-03',
      type: 'WAITING',
      description: 'aguardando outra coisa',
      waitingFor: 'AGENT-02',
      pointer: parsePointer('src/Payments.cs::RefundService.Cancel()')
    });
    assert.equal(await service.messages.unreadCount('AGENT-02'), 2);
  });
});

test('waiting on an unregistered agent is recorded but not delivered', async () => {
  await withProject(async service => {
    await service.register('AGENT-03');
    const result = await service.activity({
      agentId: 'AGENT-03',
      type: 'WAITING',
      description: 'aguardando fantasma',
      waitingFor: 'AGENT-99'
    });
    assert.equal(result.state.status, 'WAITING');
    assert.equal(result.state.current?.waitingFor, 'AGENT-99');

    // Nothing to deliver to, and nothing blew up.
    const events = await service.store.recentActivities(5);
    assert.equal(events.filter(e => e.type === 'MESSAGE').length, 0);
  });
});

test('delivery to an unregistered agent is refused', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await assert.rejects(
      () => service.sendMessage({ from: 'AGENT-01', to: 'AGENT-99', body: 'olá' }),
      /unregistered agent: AGENT-99/
    );
  });
});

test('an unattributed sender does not get a history file', async () => {
  await withProject(async (service, _call, root) => {
    await service.register('AGENT-01');
    await service.sendMessage({ from: 'OPERATOR', to: 'AGENT-01', body: 'prioridade mudou' });

    assert.deepEqual(await service.store.listHistoryAgents(), ['AGENT-01']);
    const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.doesNotMatch(history, /prioridade mudou/, 'the recipient history records what it did, not what it was told');
  });
});

test('unread counts surface in the snapshot and in the MCP status', async () => {
  await withProject(async (service, call) => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: 'olha isso' });

    const snapshot = await buildSnapshot(service);
    const byId = new Map(snapshot.agents.map(a => [a.id, a]));
    assert.equal(byId.get('AGENT-02')!.unread, 1);
    assert.equal(byId.get('AGENT-01')!.unread, 0);

    const status = await call('memory_status', { agent: 'AGENT-02' });
    assert.match(status.content[0].text, /Unread messages: 1/);
    assert.match(status.content[0].text, /You have 1 unread message\(s\)/);
  });
});

test('the MCP tools send and read messages end to end', async () => {
  await withProject(async (service, call) => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');

    const sent = await call('memory_send', {
      agent: 'AGENT-01',
      to: 'AGENT-02',
      message: 'terminei CancelAsync, pode integrar',
      pointer: 'src/Orders.cs::OrderService.CancelAsync(Guid orderId)'
    });
    assert.match(sent.content[0].text, /Delivered to AGENT-02/);

    const peek = await call('memory_inbox', { agent: 'AGENT-02', peek: true });
    assert.match(peek.content[0].text, /from AGENT-01/);
    assert.match(peek.content[0].text, /1 message\(s\) unread/);
    assert.equal(await service.messages.unreadCount('AGENT-02'), 1);

    const read = await call('memory_inbox', { agent: 'AGENT-02' });
    assert.match(read.content[0].text, /terminei CancelAsync/);
    assert.equal(await service.messages.unreadCount('AGENT-02'), 0);

    const empty = await call('memory_inbox', { agent: 'AGENT-02' });
    assert.match(empty.content[0].text, /No unread messages/);

    const all = await call('memory_inbox', { agent: 'AGENT-02', all: true });
    assert.match(all.content[0].text, /terminei CancelAsync/);
  });
});

test('the agent already on a file is told when another one arrives', async () => {
  // Regression: the agent already on the file was not warned and overwrote the newcomer's change.
  await withProject(async (service, call) => {
    await service.register('FIRST');
    await service.register('SECOND');
    await service.activity({ agentId: 'FIRST', type: 'INTENT', description: 'quebrarLinhas', pointer: parsePointer('src/texto.js') });

    const second = await service.activity({ agentId: 'SECOND', type: 'INTENT', description: 'contarPalavras', pointer: parsePointer('src/texto.js') });
    assert.equal(second.conflicts.length, 1, 'the newcomer is warned, as before');

    const inbox = await service.readInbox('FIRST', { markRead: false });
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].kind, 'overlap');
    assert.match(inbox.messages[0].body, /SECOND .*src\/texto\.js.*Re-read/);

    // Announcing again on the same file does not repeat the notice...
    await service.activity({ agentId: 'SECOND', type: 'TESTING', description: 'rodando os testes', pointer: parsePointer('src/texto.js') });
    assert.equal((await service.readInbox('FIRST', { markRead: false })).messages.length, 1);

    // ...but a write does: it is what made the first agent's copy stale.
    await service.activity({ agentId: 'SECOND', type: 'CHANGED', description: 'contarPalavras pronta', pointer: parsePointer('src/texto.js') });
    const after = await service.readInbox('FIRST', { markRead: false });
    assert.equal(after.messages.length, 2);
    assert.match(after.messages[1].body, /SECOND just changed .*stale/);

    // And the first agent's next record says there is something to read before writing.
    const recorded = await call('memory_record', { agent: 'FIRST', type: 'CHANGED', message: 'quebrarLinhas pronta', pointer: 'src/texto.js' });
    assert.match(recorded.content[0].text, /2 unread message\(s\)/);
  });
});
