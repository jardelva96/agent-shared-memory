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
    await service.register('QA2');
    await service.register('QA3');
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
    assert.match(reopened.result ?? '', /review rejected/);
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

    // Landing the parts one at a time must not release the synthesis early.
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
    // A dependency on an unknown task could never be satisfied.
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

test('the gate stays shut: a rejected review is re-armed for the redone work', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar mediana',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');
    const review = (await service.claimTask('QA'))!;
    await service.finishTask(review.id, 'FAILED', 'o arquivo nao existe', 'QA');

    // The work is back in the queue, and nothing is reviewable while it is unfinished.
    assert.equal((await service.tasks.read(work.id)).status, 'OPEN');
    assert.equal(await service.claimTask('QA'), undefined, 'nothing to judge yet');

    // Redoing it must put it back under review, not close it unwatched.
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'agora escrevi mesmo', 'DEV');
    const second = await service.claimTask('QA');
    assert.ok(second, 'the redone work is under review again');
    assert.notEqual(second.id, review.id, 'a fresh review, so each objection stays readable');
    assert.equal(second.reviewOf, work.id);

    await service.finishTask(second.id, 'DONE', 'conferido', 'QA');
    assert.equal((await service.tasks.read(work.id)).status, 'DONE');
  });
});

test('endless rejection stops at the limit instead of billing forever', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'trabalho impossivel',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });

    // maxReviewRounds defaults to 3, so the third rejection is the one that stops it.
    for (let round = 1; round <= 3; round++) {
      await service.claimTask('DEV');
      await service.finishTask(work.id, 'DONE', `tentativa ${round}`, 'DEV');
      const review = await service.claimTask('QA');
      assert.ok(review, `round ${round} is reviewable`);
      await service.finishTask(review.id, 'FAILED', `ainda errado (${round})`, 'QA');
    }

    const settled = await service.tasks.read(work.id);
    assert.equal(settled.status, 'FAILED', 'it stops rather than looping');
    assert.equal(settled.reviewRounds, 3);
    assert.match(settled.result!, /human decision/);
    assert.equal(await service.claimTask('DEV'), undefined, 'and nobody picks it up again');
  });
});

test('a reviewer that dies without judging is not read as a rejection', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');
    const review = (await service.claimTask('QA'))!;

    // The runner closes it from a non-zero exit: session limit, OOM, dropped connection.
    await service.finishTask(review.id, 'FAILED', 'exit 1: session limit', 'QA', { fromExitCode: true });

    const settledWork = await service.tasks.read(work.id);
    assert.equal(settledWork.status, 'DONE', 'correct work is not bounced back to the doer');
    assert.equal(settledWork.reviewRounds ?? 0, 0, 'and no rejection round is burned');
    assert.equal(await service.claimTask('DEV'), undefined, 'the doer has nothing to redo');

    const retry = await service.claimTask('QA');
    assert.equal(retry?.id, review.id, 'the review itself goes back to the queue');
  });
});

test('a reviewer that keeps dying eventually stops instead of requeueing forever', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    // maxTaskAttempts defaults to 3; the third crash is the one that gives up.
    let review = (await service.claimTask('QA'))!;
    for (let crash = 1; crash <= 3; crash++) {
      await service.finishTask(review.id, 'FAILED', `exit 1: crash ${crash}`, 'QA', { fromExitCode: true });
      if (crash < 3) review = (await service.claimTask('QA'))!;
    }

    assert.equal(await service.claimTask('QA'), undefined, 'it stops asking');
    const dead = await service.tasks.read(review.id);
    assert.equal(dead.status, 'FAILED');
    assert.match(dead.result!, /without a verdict/);
    assert.match(dead.result!, /human decision/);
  });
});

test('a real rejection still rejects, exit code or not', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar cache',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'QA'
    });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');
    const review = (await service.claimTask('QA'))!;

    // The agent judged through the tools; the runner's later call is already a no-op.
    await service.finishTask(review.id, 'FAILED', 'o cache nunca expira', 'QA');
    await service.finishTask(review.id, 'FAILED', 'exit 1', 'QA', { fromExitCode: true });

    const bounced = await service.tasks.read(work.id);
    assert.equal(bounced.status, 'OPEN', 'the verdict still sends the work back');
    assert.equal(bounced.reviewRounds, 1);
    assert.match(bounced.detail!, /nunca expira/);
  });
});

test('nobody reviews their own work, even when the review is open to anyone', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewOpen: true });
    const reviewId = (await service.tasks.read(work.id)).reviewTaskId!;
    assert.equal((await service.tasks.read(reviewId)).assignedTo, undefined, 'open to anyone');

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    // DEV just finished, so it is the first idle agent and would otherwise take its own review.
    assert.equal(await service.claimTask('DEV'), undefined, 'the doer is not offered its own review');
    assert.equal((await service.claimTask('QA'))?.id, reviewId, 'anyone else may take it');
  });
});

test('an open review stays open on the next round instead of pinning the first reviewer', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewOpen: true });
    const first = (await service.tasks.read(work.id)).reviewTaskId!;

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'v1', 'DEV');
    await service.claimTask('QA');
    await service.finishTask(first, 'FAILED', 'faltou tratar lista vazia', 'QA');

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'v2', 'DEV');

    const second = (await service.tasks.read(work.id)).reviewTaskId!;
    assert.notEqual(second, first);
    assert.equal((await service.tasks.read(second)).assignedTo, undefined, 'still open, not pinned to QA');
    assert.equal((await service.claimTask('LEAD'))?.id, second, 'a different free agent can judge round 2');
  });
});

test('a named reviewer is still honoured, and still cannot be the doer', async () => {
  await withProject(async service => {
    const work = await service.createTask({
      title: 'implementar',
      createdBy: 'LEAD',
      assignedTo: 'DEV',
      reviewBy: 'DEV'
    });
    const reviewId = (await service.tasks.read(work.id)).reviewTaskId!;

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    // Naming the doer as its own reviewer is a misconfiguration.
    assert.equal(await service.claimTask('DEV'), undefined);
    assert.equal((await service.tasks.read(reviewId)).status, 'OPEN');
  });
});

test('three reviewers decide by majority, and one dissent does not sink the work', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewers: 3 });
    assert.equal((await service.tasks.read(work.id)).reviewers, 3);

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    // A reviewer can read the right code and still return the wrong verdict.
    const dissent = (await service.claimTask('QA'))!;
    await service.finishTask(dissent.id, 'FAILED', 'discordo', 'QA');
    assert.equal((await service.tasks.read(work.id)).status, 'DONE', 'one vote is not the verdict');

    const second = (await service.claimTask('QA2'))!;
    await service.finishTask(second.id, 'DONE', 'conferido', 'QA2');
    assert.equal((await service.tasks.read(work.id)).status, 'DONE', 'still one short of a majority');

    const third = (await service.claimTask('QA3'))!;
    await service.finishTask(third.id, 'DONE', 'conferido', 'QA3');
    assert.equal((await service.tasks.read(work.id)).status, 'DONE', 'approved 2-1');
  });
});

test('a majority to reject sends the work back and stops the seats still working', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewers: 3 });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    const a = (await service.claimTask('QA'))!;
    await service.finishTask(a.id, 'FAILED', 'nao compila', 'QA');
    const b = (await service.claimTask('QA2'))!;
    await service.finishTask(b.id, 'FAILED', 'idem', 'QA2');

    const reopened = await service.tasks.read(work.id);
    assert.equal(reopened.status, 'OPEN', 'rejected 2 of 3');
    assert.match(reopened.detail ?? '', /nao compila|idem/);

    // The third seat cannot change the outcome, so it is not left costing a model call.
    const round1 = (await service.tasks.list()).filter(t => t.reviewOf === work.id && (t.reviewRound ?? 1) === 1);
    assert.equal(round1.filter(t => t.status === 'CANCELLED').length, 1, 'the undecided seat was closed');

    // The only thing left for a free agent is the work itself, back in the queue.
    const next = await service.claimTask('QA3');
    assert.equal(next?.id, work.id, 'the reopened work, not a spent review');
  });
});

test('the next round gets a full panel again, not a single reviewer', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewers: 3 });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'v1', 'DEV');
    await service.finishTask((await service.claimTask('QA'))!.id, 'FAILED', 'errado', 'QA');
    await service.finishTask((await service.claimTask('QA2'))!.id, 'FAILED', 'errado', 'QA2');

    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'v2', 'DEV');

    const round2 = (await service.tasks.list()).filter(t => t.reviewOf === work.id && t.reviewRound === 2);
    assert.equal(round2.length, 3, 'the panel does not shrink after a rejection');
    assert.ok(round2.every(t => t.status === 'OPEN'));
  });
});

test('one agent cannot take two seats on the same panel', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'implementar', createdBy: 'LEAD', reviewers: 3 });
    await service.claimTask('DEV');
    await service.finishTask(work.id, 'DONE', 'pronto', 'DEV');

    const first = await service.claimTask('QA');
    assert.ok(first, 'QA takes a seat');
    // One agent must not hold two seats on the same panel.
    assert.equal(await service.claimTask('QA'), undefined, 'and only one');
    assert.ok(await service.claimTask('QA2'), 'a different agent still can');
  });
});

test('naming a reviewer and asking for a panel is refused rather than half-honoured', async () => {
  await withProject(async service => {
    await assert.rejects(
      () => service.createTask({ title: 'x', createdBy: 'LEAD', reviewBy: 'QA', reviewers: 3 }),
      /open review/,
      'asking one agent three times is three times the cost for one opinion'
    );

    assert.equal((await service.tasks.list()).length, 0, 'the refused task was never persisted');
  });
});

test('reviewer panels reject invalid sizes before queuing anything', async () => {
  await withProject(async service => {
    for (const reviewers of [0, -1, 1.5, 10]) {
      await assert.rejects(
        () => service.createTask({ title: `painel ${reviewers}`, createdBy: 'LEAD', reviewers }),
        /reviewers/,
        `${reviewers} is not a valid panel size`
      );
    }

    assert.equal((await service.tasks.list()).length, 0);
  });
});
