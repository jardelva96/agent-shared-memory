import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { ScheduleStore } from '../src/core/tasks.js';

async function withProject(
  overrides: Record<string, unknown>,
  fn: (service: AgentMemoryService, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-task-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Task Project', overrides);
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a queued task waits until someone claims it', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');

    const task = await service.createTask({
      title: 'Documentar parseArgs',
      detail: 'Explicar a nova ordem de flags',
      createdBy: 'AGENT-01',
      pointer: { file: 'README.md' }
    });
    assert.equal(task.status, 'OPEN');
    assert.equal(task.depth, 0);
    assert.equal(task.attempts, 0);

    const claimed = await service.claimTask('AGENT-02');
    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.status, 'CLAIMED');
    assert.equal(claimed?.claimedBy, 'AGENT-02');
    assert.equal(claimed?.attempts, 1);

    // Nothing else is left to take.
    assert.equal(await service.claimTask('AGENT-01'), undefined);

    const done = await service.finishTask(task.id, 'DONE', 'README atualizado');
    assert.equal(done.status, 'DONE');
    assert.equal(done.result, 'README atualizado');
  });
});

test('two agents never claim the same task', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await service.register('AGENT-03');
    for (let i = 0; i < 6; i++) {
      await service.createTask({ title: `tarefa ${i}`, createdBy: 'AGENT-01' });
    }

    // Claim from two agents at once and check nothing is handed out twice.
    const rounds = await Promise.all([
      service.claimTask('AGENT-02'),
      service.claimTask('AGENT-03'),
      service.claimTask('AGENT-02'),
      service.claimTask('AGENT-03')
    ]);
    const ids = rounds.map(t => t?.id).filter(Boolean);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, 'every claim returned a distinct task');
  });
});

test('tasks are handed out oldest first', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    const first = await service.createTask({ title: 'primeira', createdBy: 'AGENT-01' });
    await new Promise(r => setTimeout(r, 5));
    await service.createTask({ title: 'segunda', createdBy: 'AGENT-01' });

    assert.equal((await service.claimTask('AGENT-02'))?.id, first.id);
  });
});

test('an assigned task is only claimable by its owner, and lands in their inbox', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await service.register('AGENT-03');

    const task = await service.createTask({
      title: 'so para o AGENT-02',
      createdBy: 'AGENT-01',
      assignedTo: 'AGENT-02'
    });

    assert.equal(await service.claimTask('AGENT-03'), undefined, 'a stranger cannot take it');
    assert.equal((await service.claimTask('AGENT-02'))?.id, task.id);

    const inbox = await service.readInbox('AGENT-02', { markRead: false });
    assert.equal(inbox.unread.length, 1);
    assert.equal(inbox.unread[0].kind, 'task');
    assert.match(inbox.unread[0].body, new RegExp(task.id));
  });
});

test('assigning to an unregistered agent is refused', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await assert.rejects(
      () => service.createTask({ title: 'x', createdBy: 'AGENT-01', assignedTo: 'AGENT-99' }),
      /unregistered agent: AGENT-99/
    );
  });
});

test('an abandoned claim returns to the pool instead of blocking the queue', async () => {
  await withProject({ taskClaimSeconds: 1 }, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    const task = await service.createTask({ title: 'orfa', createdBy: 'AGENT-01' });

    const claimed = await service.claimTask('AGENT-02');
    assert.equal(claimed?.id, task.id);
    assert.equal(await service.claimTask('AGENT-01'), undefined, 'still held while fresh');

    // The runner "dies" without finishing; the claim expires.
    await new Promise(r => setTimeout(r, 1100));

    const reclaimed = await service.claimTask('AGENT-01');
    assert.equal(reclaimed?.id, task.id, 'the work is picked up again');
    assert.equal(reclaimed?.attempts, 2, 'the retry is counted');
  });
});

test('spawn depth is bounded so agents cannot chain forever', async () => {
  await withProject({ maxTaskDepth: 2 }, async service => {
    await service.register('AGENT-01');

    const root = await service.createTask({ title: 'raiz', createdBy: 'AGENT-01' });
    assert.equal(root.depth, 0);

    const child = await service.createTask({ title: 'filha', createdBy: 'AGENT-01', parentTaskId: root.id });
    assert.equal(child.depth, 1);

    const grandchild = await service.createTask({
      title: 'neta',
      createdBy: 'AGENT-01',
      parentTaskId: child.id
    });
    assert.equal(grandchild.depth, 2);

    await assert.rejects(
      () => service.createTask({ title: 'bisneta', createdBy: 'AGENT-01', parentTaskId: grandchild.id }),
      /depth limit reached \(2\)/
    );
  });
});

test('finishing a task reports back to whoever asked for it', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    const task = await service.createTask({ title: 'entregar relatorio', createdBy: 'AGENT-01' });
    await service.claimTask('AGENT-02');
    await service.readInbox('AGENT-01');

    await service.finishTask(task.id, 'FAILED', 'faltou credencial');

    const inbox = await service.readInbox('AGENT-01', { markRead: false });
    assert.equal(inbox.unread.length, 1);
    assert.match(inbox.unread[0].body, /failed/);
    assert.match(inbox.unread[0].body, /faltou credencial/);
    assert.equal(inbox.unread[0].from, 'AGENT-02');
  });
});

test('a due schedule materialises exactly one task and moves on', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    const schedule = await service.createSchedule({
      cron: '*/5 * * * *',
      title: 'varredura periodica',
      createdBy: 'AGENT-01'
    });
    assert.ok(schedule.nextRunAt, 'the next run is computed up front');

    // Nothing is due yet.
    assert.deepEqual(await service.runDueSchedules(new Date(Date.now() - 60_000)), []);

    // Far enough in the future that the slot has passed.
    const created = await service.runDueSchedules(new Date(Date.now() + 10 * 60_000));
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'varredura periodica');
    assert.equal(created[0].scheduleId, schedule.id);
    assert.equal(created[0].createdBy, 'AGENT-01');

    const after = await service.schedules.read(schedule.id);
    assert.ok(after.lastRunAt, 'the firing is recorded');
    assert.ok(new Date(after.nextRunAt!) > new Date(), 'the next slot is in the future');
  });
});

test('a disabled schedule never fires, and a bad cron is refused at creation', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await assert.rejects(
      () => service.createSchedule({ cron: 'nonsense', title: 'x', createdBy: 'AGENT-01' }),
      /Invalid cron/
    );

    const schedule = await service.createSchedule({
      cron: '* * * * *',
      title: 'desligada',
      createdBy: 'AGENT-01'
    });
    schedule.enabled = false;
    await service.schedules.write(schedule);

    assert.deepEqual(await service.runDueSchedules(new Date(Date.now() + 60 * 60_000)), []);
  });
});

test('concurrent schedulers do not fire the same slot twice', async () => {
  await withProject({}, async service => {
    await service.register('AGENT-01');
    await service.createSchedule({ cron: '* * * * *', title: 'unica', createdBy: 'AGENT-01' });

    const when = new Date(Date.now() + 10 * 60_000);
    const rounds = await Promise.all([
      service.runDueSchedules(when),
      service.runDueSchedules(when),
      service.runDueSchedules(when)
    ]);

    const total = rounds.reduce((sum, tasks) => sum + tasks.length, 0);
    assert.equal(total, 1, 'the slot was materialised once');
  });
});

test('computeNextRun rolls forward from the given instant', () => {
  const from = new Date('2026-03-10T08:00:00');
  const next = ScheduleStore.computeNextRun('0 9 * * *', from);
  assert.equal(new Date(next!).getHours(), 9);
  assert.ok(new Date(next!) > from);
});
