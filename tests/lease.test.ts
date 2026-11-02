import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';

async function withProject(
  overrides: Record<string, unknown>,
  fn: (service: AgentMemoryService) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-lease-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Lease', { autoCompactAfterEvents: 0, ...overrides });
    await service.register('W1');
    await service.register('W2');
    await fn(service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a poisonous task is dead-lettered instead of returning to the queue forever', async () => {
  await withProject({ taskClaimSeconds: 1, maxTaskAttempts: 2 }, async service => {
    const task = await service.createTask({ title: 'veneno', createdBy: 'W1' });

    // Every run dies without finishing, so the claim just expires.
    await service.claimTask('W1');
    await new Promise(r => setTimeout(r, 1100));
    await service.claimTask('W1');
    await new Promise(r => setTimeout(r, 1100));

    // Third claim attempt: attempts has reached the ceiling, so it is failed, not reissued.
    assert.equal(await service.claimTask('W1'), undefined, 'the queue no longer hands it out');

    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.result ?? '', /abandoned after 2 attempt/);
  });
});

test('a poisonous task does not block the queue behind it', async () => {
  await withProject({ taskClaimSeconds: 1, maxTaskAttempts: 1 }, async service => {
    const poison = await service.createTask({ title: 'veneno', createdBy: 'W1' });
    await new Promise(r => setTimeout(r, 5));
    const good = await service.createTask({ title: 'saudavel', createdBy: 'W1' });

    // The poison is older, so it is handed out first and then abandoned.
    assert.equal((await service.claimTask('W1'))?.id, poison.id);
    await new Promise(r => setTimeout(r, 1100));

    // Without the dead letter this returned the poison again, ahead of everything queued
    // after it, because its createdAt never changes.
    assert.equal((await service.claimTask('W2'))?.id, good.id, 'the healthy task gets through');
    assert.equal((await service.tasks.read(poison.id)).status, 'FAILED');
  });
});

test('the dead letter is off when maxTaskAttempts is zero', async () => {
  await withProject({ taskClaimSeconds: 1, maxTaskAttempts: 0 }, async service => {
    const task = await service.createTask({ title: 'sem teto', createdBy: 'W1' });
    for (let i = 0; i < 3; i++) {
      await service.claimTask('W1');
      await new Promise(r => setTimeout(r, 1100));
    }
    assert.equal((await service.claimTask('W1'))?.id, task.id, 'still reissued');
    assert.equal((await service.tasks.read(task.id)).status, 'CLAIMED');
  });
});

test('a task that finishes inside its lease is accepted', async () => {
  await withProject({ taskClaimSeconds: 60, maxTaskAttempts: 3 }, async service => {
    const task = await service.createTask({ title: 'normal', createdBy: 'W1' });
    await service.claimTask('W1');
    const done = await service.finishTask(task.id, 'DONE', 'ok', 'W1');
    assert.equal(done.status, 'DONE');
  });
});
