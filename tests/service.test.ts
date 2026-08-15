import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';

test('register, activity, history and central memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-test-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Test Project');
    await service.register('AGENT-01', 'Backend', 'AUTH-1');
    await service.activity({
      agentId: 'AGENT-01',
      type: 'INTENT',
      description: 'Corrigindo token expirado.',
      pointer: parsePointer('src/Auth.cs::Auth.Validate()')
    });

    const memory = await service.store.readSharedMemory();
    assert.match(memory, /AGENT-01 \| WORKING/);
    assert.match(memory, /Corrigindo token expirado/);
    assert.match(memory, /Auth\.Validate/);

    const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(history, /REGISTERED/);
    assert.match(history, /INTENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports an active semantic conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-test-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Conflict Project');
    await service.register('AGENT-01');
    await service.register('AGENT-02');

    const pointer = parsePointer('src/OrderService.cs::OrderService.CancelAsync(Guid id)');
    await service.activity({ agentId: 'AGENT-01', type: 'INTENT', description: 'Alterando cancelamento.', pointer });
    const result = await service.activity({ agentId: 'AGENT-02', type: 'INTENT', description: 'Também alterando cancelamento.', pointer });

    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].agentId, 'AGENT-01');
    assert.equal(result.conflicts[0].exact, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
