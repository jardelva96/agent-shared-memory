import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';

async function withProject(
  overrides: Record<string, unknown>,
  fn: (service: AgentMemoryService, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-auto-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Auto Compact', overrides);
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function burst(service: AgentMemoryService, agent: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await service.activity({ agentId: agent, type: 'NOTE', description: `evento ${i}` });
  }
}

test('the journal is archived on its own once it passes the limit', async () => {
  await withProject({ autoCompactAfterEvents: 40, recentHistoryLimit: 5 }, async (service, root) => {
    await service.register('AGENT-01');
    await burst(service, 'AGENT-01', 60);

    const live = await service.store.countEvents();
    assert.ok(live <= 40, `journal stayed bounded, got ${live}`);
    assert.ok(live >= 20, `the newest half is kept, got ${live}`);

    // Nothing is destroyed: the trimmed events are on disk.
    const archives = await readdir(path.join(root, '.agents', 'events', 'archive'));
    assert.ok(archives.length > 0, 'old events were archived, not deleted');

    // The newest events are the ones that stayed.
    const recent = await service.store.recentActivities(3);
    assert.equal(recent[0].description, 'evento 59');
  });
});

test('auto compaction is off when the limit is zero', async () => {
  await withProject({ autoCompactAfterEvents: 0 }, async (service, root) => {
    await service.register('AGENT-01');
    await burst(service, 'AGENT-01', 50);

    assert.equal(await service.store.countEvents(), 51, 'every event is still live');
    const archives = await readdir(path.join(root, '.agents', 'events', 'archive')).catch(() => []);
    assert.deepEqual(archives, []);
  });
});

test('lowering the limit through config compacts immediately', async () => {
  await withProject({ autoCompactAfterEvents: 0 }, async service => {
    await service.register('AGENT-01');
    await burst(service, 'AGENT-01', 60);
    assert.equal(await service.store.countEvents(), 61);

    await service.updateConfig({ autoCompactAfterEvents: 20 });
    assert.ok((await service.store.countEvents()) <= 20, 'the new limit is applied on the spot');
  });
});

test('a compacted journal still feeds the panel and the conflict check', async () => {
  await withProject({ autoCompactAfterEvents: 30, recentHistoryLimit: 5 }, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await burst(service, 'AGENT-01', 50);

    const pointer = { file: 'src/Orders.cs', symbol: 'OrderService.Cancel()' };
    await service.activity({ agentId: 'AGENT-01', type: 'INTENT', description: 'cancelamento', pointer });
    const clash = await service.activity({
      agentId: 'AGENT-02',
      type: 'INTENT',
      description: 'também cancelamento',
      pointer
    });

    assert.equal(clash.conflicts.length, 1, 'conflict detection reads state, not the journal');
    assert.equal(clash.conflicts[0].agentId, 'AGENT-01');

    const memory = await service.store.readSharedMemory();
    assert.match(memory, /AGENT-01 \| WORKING/);
    assert.match(memory, /cancelamento/);
  });
});
