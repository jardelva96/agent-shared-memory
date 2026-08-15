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

test('a verdict already recorded by the agent is not overwritten by the runner', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'trabalho',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    const review = work.reviewTaskId!;
    await service.claimTask('QA');

    // The agent records its own verdict through the tools...
    await service.finishTask(review, 'FAILED', 'nao compila', 'QA');
    // ...and the runner then closes the same task from a zero exit code.
    await service.finishTask(review, 'DONE', 'exit 0', 'QA');

    assert.equal((await service.tasks.read(review)).status, 'FAILED', 'the agent verdict stands');
    assert.equal((await service.tasks.read(work.id)).status, 'OPEN', 'so the work still went back');
  });
});

test('a synthesis waits for every part, not just the first', async () => {
  await withProject(async service => {
    const parts = [];
    for (const title of ['parte 1', 'parte 2', 'parte 3']) {
      parts.push(await service.createTask({ title, createdBy: 'LEAD', assignedTo: 'DEV' }));
    }
    const synthesis = await service.createTask({
      title: 'conferir o conjunto',
      createdBy: 'LEAD',
      assignedTo: 'QA',
      dependsOn: parts.map(p => p.id)
    });

    // Landing them one at a time must not release the synthesis early: reviewing two
    // finished parts and one still in flight is exactly the hole this guards against.
    for (const part of parts) {
      assert.equal(await service.claimTask('QA'), undefined, `still blocked before ${part.title} landed`);
      await service.claimTask('DEV');
      await service.finishTask(part.id, 'DONE', 'ok', 'DEV');
    }

    assert.equal((await service.claimTask('QA'))?.id, synthesis.id, 'released once every part landed');
  });
});

test('one failed part keeps the synthesis blocked rather than reviewing a hole', async () => {
  await withProject(async service => {
    const a = await service.createTask({ title: 'parte a', createdBy: 'LEAD', assignedTo: 'DEV' });
    const b = await service.createTask({ title: 'parte b', createdBy: 'LEAD', assignedTo: 'DEV' });
    await service.createTask({
      title: 'conferir',
      createdBy: 'LEAD',
      assignedTo: 'QA',
      dependsOn: [a.id, b.id]
    });

    await service.claimTask('DEV');
    await service.finishTask(a.id, 'DONE', 'ok', 'DEV');
    await service.claimTask('DEV');
    await service.finishTask(b.id, 'FAILED', 'estourou', 'DEV');

    assert.equal(await service.claimTask('QA'), undefined, 'nothing to synthesise from a failed part');
  });
});

test('the single-value form still works for tasks written before the list', async () => {
  await withProject(async service => {
    const first = await service.createTask({ title: 'primeiro', createdBy: 'LEAD', assignedTo: 'DEV' });
    const second = await service.createTask({ title: 'segundo', createdBy: 'LEAD', assignedTo: 'QA' });

    // Written to disk the way older versions wrote it: a bare string, not a list.
    const raw = await service.tasks.read(second.id);
    (raw as { dependsOn?: unknown }).dependsOn = first.id;
    await service.tasks.write(raw);

    assert.equal(await service.claimTask('QA'), undefined, 'the old form still blocks');
    await service.claimTask('DEV');
    await service.finishTask(first.id, 'DONE', 'ok', 'DEV');
    assert.equal((await service.claimTask('QA'))?.id, second.id, 'and still unblocks');
  });
});

test('a dependency on a task that does not exist is refused at creation', async () => {
  await withProject(async service => {
    // Accepting the typo would queue a task that can never be claimed: nothing will ever
    // mark T-NAOEXISTE done, so it sits OPEN forever while the listing looks healthy.
    await assert.rejects(
      () => service.createTask({ title: 'sintese', createdBy: 'LEAD', dependsOn: ['T-NAOEXISTE'] }),
      /does not exist/
    );

    const real = await service.createTask({ title: 'parte', createdBy: 'LEAD' });
    await assert.rejects(
      () => service.createTask({ title: 'sintese', createdBy: 'LEAD', dependsOn: [real.id, 'T-ERRADO'] }),
      /does not exist/,
      'one bad id in the list is still a bad list'
    );
  });
});
