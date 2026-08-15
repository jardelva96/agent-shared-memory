import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';

async function withProject(fn: (service: AgentMemoryService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-rev-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Review', { autoCompactAfterEvents: 0 });
    await service.register('LEAD');
    await service.register('DEV');
    await service.register('QA');
    await fn(service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a blocked task is invisible to the queue until its dependency lands', async () => {
  await withProject(async service => {
    const first = await service.createTask({ title: 'primeiro', createdBy: 'LEAD' });
    const second = await service.createTask({ title: 'segundo', createdBy: 'LEAD', dependsOn: first.id });

    assert.equal((await service.claimTask('DEV'))?.id, first.id);
    assert.equal(await service.claimTask('QA'), undefined, 'the dependent one is not handed out yet');

    await service.finishTask(first.id, 'DONE', 'ok', 'DEV');
    assert.equal((await service.claimTask('QA'))?.id, second.id, 'unblocked by the dependency landing');
  });
});

test('review-by queues a linked review that waits for the work', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });

    assert.ok(work.reviewTaskId, 'the review exists from the start');
    const review = await service.tasks.read(work.reviewTaskId!);
    assert.equal(review.reviewOf, work.id);
    assert.equal(review.dependsOn, work.id);
    assert.equal(review.assignedTo, 'QA');

    // QA cannot review anything yet.
    assert.equal(await service.claimTask('QA'), undefined);

    assert.equal((await service.claimTask('DEV'))?.id, work.id);
    await service.finishTask(work.id, 'DONE', 'implementado', 'DEV');

    assert.equal((await service.claimTask('QA'))?.id, review.id, 'review unblocks after the work');
  });
});

test('a rejected review sends the work back with the reason attached', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      detail: 'com TTL',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');
    await service.claimTask('QA');

    await service.finishTask(work.reviewTaskId!, 'FAILED', 'nao compila: syncDir nao existe', 'QA');

    const reopened = await service.tasks.read(work.id);
    assert.equal(reopened.status, 'OPEN', 'done is no longer self-declared');
    assert.equal(reopened.claimedBy, undefined);
    assert.match(reopened.result ?? '', /revisao rejeitou/);
    assert.match(reopened.detail ?? '', /syncDir nao existe/, 'the next attempt starts from the objection');

    // And it can be picked up again.
    assert.equal((await service.claimTask('DEV'))?.id, work.id);
  });
});

test('an accepted review leaves the work done', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');
    await service.claimTask('QA');
    await service.finishTask(work.reviewTaskId!, 'DONE', 'conferido, compila e testa', 'QA');

    assert.equal((await service.tasks.read(work.id)).status, 'DONE');
  });
});

test('a review is cancelled when the work it would judge failed', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'tarefa que falha',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'FAILED', 'estourou', 'DEV');

    assert.equal((await service.tasks.read(work.reviewTaskId!)).status, 'CANCELLED');
    assert.equal(await service.claimTask('QA'), undefined, 'nothing left blocking the queue');
  });
});
