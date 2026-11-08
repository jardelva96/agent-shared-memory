import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';
import { readyFor } from '../src/core/tasks.js';
import { AgentTask, ProjectConfig } from '../src/models/types.js';

async function withService(
  config: Partial<ProjectConfig>,
  fn: (service: AgentMemoryService, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-archive-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Archive', config);
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const liveFiles = async (root: string) =>
  (await readdir(path.join(root, '.agents', 'tasks'))).filter(f => f.endsWith('.json'));

function task(id: string, fields: Partial<AgentTask>): AgentTask {
  const at = new Date(Date.parse('2026-01-01T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000).toISOString();
  return { id, title: id, createdBy: 'A', status: 'DONE', attempts: 1, depth: 0, createdAt: at, updatedAt: at, finishedAt: at, ...fields };
}

test('closed tasks past the limit move to the archive and stay readable', async () => {
  await withService({ maxClosedTasks: 10 }, async (service, root) => {
    await service.register('A');
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push((await service.createTask({ title: `t${i}`, createdBy: 'A' })).id);
    for (let i = 0; i < 30; i++) {
      const claimed = await service.claimTask('A');
      await service.finishTask(claimed!.id, 'DONE', 'ok', 'A');
    }
    await service.createTask({ title: 'last', createdBy: 'A' });
    await service.claimTask('A');

    assert.ok((await liveFiles(root)).length <= 11, 'at most the limit of closed tasks, plus the claimed one');
    assert.equal((await service.tasks.list({ archived: true })).length, 31);
    assert.equal((await service.tasks.list({ status: ['DONE'] })).length, 30, 'asking for a closed status reads the archive');
    assert.equal((await service.tasks.read(ids[0])).status, 'DONE');
    assert.equal((await service.taskHistory(ids[0])).task.id, ids[0]);

    // A task created later can still wait on an archived one.
    const next = await service.createTask({ title: 'after', createdBy: 'A', dependsOn: ids[0] });
    assert.deepEqual((await service.readyTasks('A')).map(t => t.id), [next.id]);
    assert.equal((await service.claimTask('A'))?.id, next.id);
  });
});

test('what open work still points at is never archived', async () => {
  await withService({}, async service => {
    const tasks = [
      task('T-1', {}),
      task('T-2', {}),
      task('T-3', {}),
      task('T-4', {}),
      task('T-5', {}),
      task('T-6', {}),
      task('T-10', { title: 'depended on' }),
      task('T-20', { title: 'work under review' }),
      task('T-21', { reviewOf: 'T-20', title: 'vote already cast' }),
      task('T-22', { reviewOf: 'T-20', status: 'OPEN', title: 'vote still open' }),
      task('T-30', { status: 'OPEN', dependsOn: ['T-10'] })
    ];
    for (const t of tasks) await service.tasks.write(t);

    const moved = await service.tasks.archiveClosed(await service.tasks.list(), 2);
    assert.equal(moved, 6);
    const live = (await service.tasks.list()).map(t => t.id).sort();
    assert.deepEqual(live, ['T-10', 'T-20', 'T-21', 'T-22', 'T-30']);
    assert.equal((await service.tasks.read('T-1')).status, 'DONE', 'archived, still readable');
  });
});

test('the votes of a panel whose last vote just landed stay until they are counted', async () => {
  await withService({}, async service => {
    const now = new Date().toISOString();
    const tasks = [
      task('T-1', {}),
      task('T-2', {}),
      task('T-3', {}),
      task('T-4', {}),
      task('T-20', { title: 'work', reviewTaskId: 'T-21', reviewers: 3 }),
      task('T-21', { reviewOf: 'T-20', title: 'first vote' }),
      task('T-22', { reviewOf: 'T-20', title: 'second vote' }),
      task('T-23', { reviewOf: 'T-20', title: 'last vote', updatedAt: now, finishedAt: now })
    ];
    for (const t of tasks) await service.tasks.write(t);

    // Every task here is closed and no open task points at the panel any more.
    assert.equal(await service.tasks.archiveClosed(await service.tasks.list(), 2), 4);
    assert.deepEqual((await service.tasks.list()).map(t => t.id), ['T-20', 'T-21', 'T-22', 'T-23']);
  });
});

test('a review panel reaches its verdict while every claim archives', async () => {
  await withService({ maxClosedTasks: 2 }, async service => {
    for (const id of ['LEAD', 'DEV', 'R1', 'R2', 'R3']) await service.register(id);
    for (let i = 0; i < 8; i++) {
      const old = await service.createTask({ title: `old ${i}`, createdBy: 'LEAD', assignedTo: 'DEV' });
      await service.claimTask('DEV');
      await service.finishTask(old.id, 'DONE', 'ok', 'DEV');
    }

    const work = await service.createTask({ title: 'median', createdBy: 'LEAD', assignedTo: 'DEV', reviewers: 3 });
    assert.equal((await service.claimTask('DEV'))?.id, work.id);
    await service.finishTask(work.id, 'DONE', 'done', 'DEV');
    for (const reviewer of ['R1', 'R2']) {
      const seat = await service.claimTask(reviewer);
      assert.equal(seat?.reviewOf, work.id, `${reviewer} got a seat on the panel`);
      await service.finishTask(seat!.id, 'DONE', 'looks right', reviewer);
    }

    assert.equal((await service.tasks.read(work.id)).status, 'DONE');
    const { events } = await service.taskHistory(work.id);
    assert.ok(events.some(e => /approved .* by majority \(2\/3\)/.test(e.description)), 'two of three decided it');
  });
});

test('a dependency archived as DONE unblocks the task waiting on it', async () => {
  await withService({}, async service => {
    await service.tasks.write(task('T-1', {}));
    await service.tasks.write(task('T-2', { status: 'FAILED' }));
    await service.tasks.write(task('T-3', { status: 'OPEN', dependsOn: ['T-1'] }));
    await service.tasks.write(task('T-4', { status: 'OPEN', dependsOn: ['T-2'] }));
    await service.tasks.archiveClosed([task('T-1', {}), task('T-2', { status: 'FAILED' })], 1);

    const live = await service.tasks.list();
    assert.deepEqual(live.map(t => t.id), ['T-3', 'T-4']);
    assert.deepEqual(readyFor(live).map(t => t.id), [], 'without the archive nothing looks ready');
    const done = await service.tasks.archivedDone(live);
    assert.deepEqual(readyFor(live, undefined, done).map(t => t.id), ['T-3'], 'a FAILED dependency still blocks');
  });
});

/** Ten writes, timed. */
async function tenWrites(service: AgentMemoryService): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    await service.activity({ agentId: 'A', type: 'NOTE', description: `n${i}`, pointer: parsePointer(`src/a${i}.ts::f`) });
  }
  return performance.now() - start;
}

test('a write does not wait for files that were never created', async () => {
  // Reservations, facts and read cursors are absent in a fresh project. Waiting for them to
  // reappear made every write take about 200 ms. A fixed limit on wall time failed on a busy
  // machine (2026-11-08), so the fresh project is compared with one where those files exist,
  // timed in the same run: a wait costs at least 1.5 s over ten writes, load slows both alike.
  let fresh = 0;
  let existing = 0;
  await withService({}, async service => {
    await service.register('A');
    fresh = await tenWrites(service);
  });
  await withService({}, async service => {
    await service.register('A');
    await service.register('B');
    await service.reserve('A', ['tmp/x']);
    await service.release('A');
    await service.forget((await service.remember('x', 'A')).id);
    await service.sendMessage({ from: 'B', to: 'A', body: 'x' });
    await service.readInbox('A');
    existing = await tenWrites(service);
  });
  assert.ok(fresh < existing + 750, `10 writes took ${Math.round(fresh)} ms fresh and ${Math.round(existing)} ms with the files present`);
});
