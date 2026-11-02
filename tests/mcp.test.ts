import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { createMcpMethods, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/server.js';
import { MethodMap } from '../src/mcp/jsonrpc.js';
import { TOOLS } from '../src/mcp/tools.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function withServer(fn: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, methods: MethodMap, service: AgentMemoryService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-mcp-'));
  try {
    const service = new AgentMemoryService(root);
    const methods = createMcpMethods(service);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;
    await fn(call, methods, service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('initialize negotiates the protocol version and advertises tools', async () => {
  await withServer(async (_call, methods) => {
    const negotiated = (await methods.get('initialize')!({ protocolVersion: '2024-11-05' })) as {
      protocolVersion: string;
      serverInfo: { name: string };
      instructions: string;
    };
    assert.equal(negotiated.protocolVersion, '2024-11-05');
    assert.equal(negotiated.serverInfo.name, 'agent-shared-memory');
    assert.match(negotiated.instructions, /READ -> INTENT -> CODE -> RESULT/);

    const unknown = (await methods.get('initialize')!({ protocolVersion: '1999-01-01' })) as {
      protocolVersion: string;
    };
    assert.equal(unknown.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);

    const listed = (await methods.get('tools/list')!(undefined)) as { tools: Array<{ name: string }> };
    assert.deepEqual(
      listed.tools.map(t => t.name).sort(),
      TOOLS.map(t => t.name).sort()
    );
  });
});

test('tools refuse to write before init instead of creating a stray .agents/', async () => {
  await withServer(async call => {
    const result = await call('memory_register', { agent: 'AGENT-01' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /agent-memory init/);
  });
});

test('register, record and status round-trip through the tools', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('MCP Project');

    const registered = await call('memory_register', { agent: 'AGENT-01', role: 'Backend', task: 'AUTH-184' });
    assert.notEqual(registered.isError, true);
    assert.match(registered.content[0].text, /Registered AGENT-01/);

    const recorded = await call('memory_record', {
      agent: 'AGENT-01',
      type: 'INTENT',
      message: 'Validar expiração do refresh token.',
      pointer: 'src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)',
      reason: 'Tokens expirados ainda são aceitos'
    });
    assert.match(recorded.content[0].text, /INTENT recorded for AGENT-01/);
    assert.match(recorded.content[0].text, /Status is now WORKING/);

    const status = await call('memory_status');
    assert.match(status.content[0].text, /AGENT-01 \| WORKING \| Backend/);
    assert.match(status.content[0].text, /ValidateRefreshToken/);

    const log = await call('memory_log', { agent: 'AGENT-01' });
    assert.match(log.content[0].text, /INTENT/);
    assert.match(log.content[0].text, /REGISTERED/);
  });
});

test('register re-attaches an existing agent instead of failing', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Reconnect Project');
    await call('memory_register', { agent: 'AGENT-01', task: 'AUTH-184' });
    await call('memory_record', { agent: 'AGENT-01', type: 'CHANGED', message: 'Validação adicionada.' });

    const again = await call('memory_register', { agent: 'AGENT-01' });
    assert.notEqual(again.isError, true);
    assert.match(again.content[0].text, /already registered; re-attached/);
    assert.match(again.content[0].text, /Validação adicionada/);
  });
});

test('overlap is reported on record and on a status pointer probe', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Conflict Project');
    await call('memory_register', { agent: 'AGENT-01' });
    await call('memory_register', { agent: 'AGENT-02' });

    const pointer = 'src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)';
    await call('memory_record', { agent: 'AGENT-01', type: 'INTENT', message: 'Alterando cancelamento.', pointer });

    const probe = await call('memory_status', { agent: 'AGENT-02', pointer });
    assert.match(probe.content[0].text, /AGENT-01 \[WORKING\] EXACT/);

    const clash = await call('memory_record', {
      agent: 'AGENT-02',
      type: 'INTENT',
      message: 'Também alterando cancelamento.',
      pointer
    });
    assert.match(clash.content[0].text, /WARNING: 1 active overlap\(s\) detected/);
    assert.match(clash.content[0].text, /AGENT-01 \[WORKING\] EXACT/);
  });
});

test('invalid activity type and unknown tool are rejected', async () => {
  await withServer(async (call, methods, service) => {
    await service.init('Validation Project');
    await call('memory_register', { agent: 'AGENT-01' });

    await assert.rejects(
      () => call('memory_record', { agent: 'AGENT-01', type: 'HEARTBEAT', message: 'x' }),
      /Invalid type: HEARTBEAT/
    );
    await assert.rejects(
      () => methods.get('tools/call')!({ name: 'memory_nope', arguments: {} }),
      /Unknown tool: memory_nope/
    );
    await assert.rejects(
      () => call('memory_record', { agent: 'AGENT-01', type: 'INTENT' }),
      /Missing required string argument: message/
    );
  });
});

test('a pinned agent id is dropped from every tool schema', async () => {
  await withServer(async (_call, _methods, service) => {
    await service.init('Pinned Project');
    const methods = createMcpMethods(service, { agentId: 'AGENT-07' });

    const listed = (await methods.get('tools/list')!(undefined)) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>;
    };
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.properties.agent, undefined, `${tool.name} still exposes agent`);
      assert.ok(!(tool.inputSchema.required ?? []).includes('agent'), `${tool.name} still requires agent`);
    }
    // Parameters that are not the identity must survive untouched.
    const send = listed.tools.find(t => t.name === 'memory_send')!;
    assert.deepEqual(send.inputSchema.required, ['to', 'message']);

    const negotiated = (await methods.get('initialize')!({})) as { instructions: string };
    assert.match(negotiated.instructions, /You are AGENT-07/);
  });
});

test('a pinned server acts as its own agent without being told', async () => {
  await withServer(async (_call, _methods, service) => {
    await service.init('Pinned Project');
    await service.register('AGENT-07');
    const methods = createMcpMethods(service, { agentId: 'AGENT-07' });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;

    const recorded = await call('memory_record', {
      type: 'INTENT',
      message: 'sem passar id',
      pointer: 'src/Auth.cs::Auth.Validate()'
    });
    assert.match(recorded.content[0].text, /INTENT recorded for AGENT-07/);

    const state = await service.store.readState('AGENT-07');
    assert.equal(state.current?.description, 'sem passar id');
  });
});

test('a pinned id cannot be impersonated by the caller', async () => {
  await withServer(async (_call, _methods, service) => {
    await service.init('Pinned Project');
    await service.register('AGENT-07');
    await service.register('AGENT-08');
    const methods = createMcpMethods(service, { agentId: 'AGENT-07' });

    // Passing someone else's id must not redirect the write.
    await methods.get('tools/call')!({
      name: 'memory_record',
      arguments: { agent: 'AGENT-08', type: 'CHANGED', message: 'tentativa de personificacao' }
    });

    const victim = await service.store.readState('AGENT-08');
    assert.notEqual(victim.current?.description, 'tentativa de personificacao');
    const owner = await service.store.readState('AGENT-07');
    assert.equal(owner.current?.description, 'tentativa de personificacao');
  });
});

test('claiming a synthesis hands over what the parts reported', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Sintese');
    await call('memory_register', { agent: 'LEAD' });

    // The lead splits the demand and queues the gathering task itself, through the tools.
    const first = await call('memory_task_create', { agent: 'LEAD', title: 'medir a parte A' });
    const second = await call('memory_task_create', { agent: 'LEAD', title: 'medir a parte B' });
    const ids = [first, second].map(r => /Queued (\S+):/.exec(r.content[0].text)![1]);

    const gather = await call('memory_task_create', {
      agent: 'LEAD',
      title: 'juntar A e B',
      after: ids.join(',')
    });
    assert.match(gather.content[0].text, /Waiting for/, 'the lead is told it will not run yet');

    await service.claimTask('LEAD');
    await service.finishTask(ids[0], 'DONE', 'A mede 12', 'LEAD');
    await service.claimTask('LEAD');
    await service.finishTask(ids[1], 'DONE', 'B mede 45', 'LEAD');

    const claimed = await call('memory_task_claim', { agent: 'LEAD' });
    const text = claimed.content[0].text;
    assert.match(text, /juntar A e B/);
    // Without these the agent is handed the question with the answers withheld.
    assert.match(text, /A mede 12/, 'the first part\u2019s result came with the claim');
    assert.match(text, /B mede 45/, 'and the second one too');
  });
});

test('a listing stays quiet about results until asked', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Sintese');
    await call('memory_register', { agent: 'LEAD' });
    const created = await call('memory_task_create', { agent: 'LEAD', title: 'medir algo' });
    const id = /Queued (\S+):/.exec(created.content[0].text)![1];
    await service.claimTask('LEAD');
    await service.finishTask(id, 'DONE', 'resposta bem longa que ninguem quer em toda listagem', 'LEAD');

    const quiet = await call('memory_task_list', { agent: 'LEAD' });
    assert.doesNotMatch(quiet.content[0].text, /resposta bem longa/, 'the default listing stays cheap');

    const loud = await call('memory_task_list', { agent: 'LEAD', with_results: true });
    assert.match(loud.content[0].text, /resposta bem longa/, 'and readable when the caller asks');
  });
});

test('a task cannot be queued behind an id that does not exist', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Sintese');
    await call('memory_register', { agent: 'LEAD' });
    const bad = await call('memory_task_create', { agent: 'LEAD', title: 'juntar', after: 'T-INVENTADO' });
    assert.equal(bad.isError, true, 'a typo here would block the task forever, silently');
    assert.match(bad.content[0].text, /does not exist/);
  });
});

test('MCP task create can queue an open review panel', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Panel');
    await call('memory_register', { agent: 'LEAD' });

    const created = await call('memory_task_create', { agent: 'LEAD', title: 'troca sensivel', reviewers: 3 });
    assert.notEqual(created.isError, true);
    assert.match(created.content[0].text, /Review queued as T-/);

    const tasks = await service.tasks.list();
    const work = tasks.find(task => task.title === 'troca sensivel')!;
    const reviews = tasks.filter(task => task.reviewOf === work.id);
    assert.equal(work.reviewers, 3);
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every(task => task.assignedTo === undefined));

    const bad = await call('memory_task_create', { agent: 'LEAD', title: 'decimal', reviewers: 2.5 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /positive integer/);
  });
});

test('a pointer reads the symbol, not the file around it', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Pointer');
    await writeFile(
      path.join(service.root, 'app.ts'),
      [
        'const antes = 1;',
        '',
        '/** O que a funcao faz. */',
        'export function alvo(x: number): number {',
        '  return x * 2;',
        '}',
        '',
        'const depois = 2;'
      ].join('\n')
    );

    const narrowed = (await call('memory_read_pointer', { pointer: 'app.ts::alvo' })).content[0].text;
    assert.match(narrowed, /O que a funcao faz/, 'the doc comment explains the symbol');
    assert.match(narrowed, /return x \* 2;/);
    assert.doesNotMatch(narrowed, /const depois/, 'the rest of the file stays out');
    assert.match(narrowed, /app\.ts:3-6/, 'and it says where the slice came from');

    const whole = (await call('memory_read_pointer', { pointer: 'app.ts' })).content[0].text;
    assert.match(whole, /const depois/, 'a file-only pointer still returns the file');
  });
});

test('a pointer cannot read outside the project', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Pointer');
    // The pointer comes from a model, so it may point anywhere.
    for (const escape of ['../../../etc/passwd', '../outside.txt']) {
      const denied = await call('memory_read_pointer', { pointer: escape });
      assert.equal(denied.isError, true, `${escape} must be refused`);
      assert.match(denied.content[0].text, /Outside the project/);
    }
  });
});

test('a symbol that is not there says so instead of guessing', async () => {
  await withServer(async (call, _methods, service) => {
    await service.init('Pointer');
    await writeFile(path.join(service.root, 'app.ts'), 'export function alvo() {}\n');
    const missing = (await call('memory_read_pointer', { pointer: 'app.ts::naoExiste' })).content[0].text;
    assert.match(missing, /not found/, 'a wrong slice would be worse than no slice');
    assert.match(missing, /Read the file/);
  });
});
