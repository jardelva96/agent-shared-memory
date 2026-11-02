import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { runQueue } from '../src/core/runner.js';

async function withProject(
  overrides: Record<string, unknown>,
  fn: (service: AgentMemoryService, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-run-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Runner Project', overrides);
    await service.register('LEAD');
    await service.register('WORKER');
    await fn(service, root);
  } finally {
    await removeWhenFree(root);
  }
}

/**
 * A killed process can still hold its working directory for a moment on Windows, so the first rmdir
 * may hit EBUSY.
 */
async function removeWhenFree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

/** Node is the one interpreter guaranteed present, and it behaves the same on every shell. */
const NODE = JSON.stringify(process.execPath);

test('the runner drains the queue and records each outcome', async () => {
  await withProject({}, async service => {
    await service.createTask({ title: 'primeira', createdBy: 'LEAD' });
    await service.createTask({ title: 'segunda', createdBy: 'LEAD' });

    const outcomes = await runQueue(service, {
      agentId: 'WORKER',
      exec: `${NODE} -e "process.exit(0)"`
    });

    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every(o => o.status === 'DONE'));

    const tasks = await service.tasks.list();
    assert.deepEqual(tasks.map(t => t.status), ['DONE', 'DONE']);
    assert.match(tasks[0].result ?? '', /exit 0/);
  });
});

test('a non-zero exit marks the task FAILED and keeps the output', async () => {
  await withProject({}, async service => {
    const task = await service.createTask({ title: 'vai falhar', createdBy: 'LEAD' });

    const [outcome] = await runQueue(service, {
      agentId: 'WORKER',
      exec: `${NODE} -e "console.log('diagnostico util'); process.exit(4)"`
    });

    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.exitCode, 4);

    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.result ?? '', /exit 4/);
    assert.match(stored.result ?? '', /diagnostico util/);
  });
});

test('the task reaches the command through the environment, never the command string', async () => {
  await withProject({}, async (service, root) => {
    const dump = path.join(root, 'dump.json');
    await service.createTask({
      title: 'titulo da tarefa',
      detail: 'detalhe da tarefa',
      createdBy: 'LEAD',
      pointer: { file: 'src/Auth.cs', symbol: 'Auth.Validate()' }
    });

    await runQueue(service, {
      agentId: 'WORKER',
      exec:
        `${NODE} -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))" ` +
        JSON.stringify(dump)
    });

    const env = JSON.parse(await readFile(dump, 'utf8')) as Record<string, string>;
    assert.equal(env.AGENT_ID, 'WORKER');
    assert.equal(env.AGENT_TASK_TITLE, 'titulo da tarefa');
    assert.equal(env.AGENT_TASK_DETAIL, 'detalhe da tarefa');
    assert.match(env.AGENT_TASK_POINTER, /Auth\.Validate/);
    assert.equal(env.AGENT_TASK_POINTER_FILE, 'src/Auth.cs');
    assert.equal(env.AGENT_TASK_DEPTH, '0');
    assert.ok(env.AGENT_TASK_ID?.startsWith('T-'));
  });
});

test('shell syntax in a task title cannot execute', async () => {
  await withProject({}, async (service, root) => {
    const marker = path.join(root, 'pwned.txt');
    // A title written by another agent, carrying a shell payload.
    await service.createTask({
      title: `relatorio"; echo INVADIDO > ${JSON.stringify(marker)}; echo "`,
      createdBy: 'LEAD'
    });

    await runQueue(service, { agentId: 'WORKER', exec: `${NODE} -e "process.exit(0)"` });

    await assert.rejects(() => readFile(marker, 'utf8'), /ENOENT/, 'the payload never ran');
  });
});

test('only the validated task id is substituted into the command', async () => {
  await withProject({}, async (service, root) => {
    const dump = path.join(root, 'id.txt');
    const task = await service.createTask({ title: 'qualquer', createdBy: 'LEAD' });

    await runQueue(service, {
      agentId: 'WORKER',
      exec:
        `${NODE} -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" ` +
        `${JSON.stringify(dump)} {{task_id}}`
    });

    assert.equal(await readFile(dump, 'utf8'), task.id);
  });
});

test('a command that hangs is killed and the task fails instead of holding the claim', async () => {
  await withProject({}, async service => {
    const task = await service.createTask({ title: 'trava', createdBy: 'LEAD' });

    const [outcome] = await runQueue(service, {
      agentId: 'WORKER',
      exec: `${NODE} -e "setTimeout(()=>{}, 60000)"`,
      timeoutMs: 400
    });

    assert.equal(outcome.status, 'FAILED');
    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'FAILED');
    assert.match(stored.result ?? '', /timed out/);
  });
});

test('a command that cannot start fails the task with the reason', async () => {
  await withProject({}, async service => {
    const task = await service.createTask({ title: 'comando inexistente', createdBy: 'LEAD' });

    const [outcome] = await runQueue(service, {
      agentId: 'WORKER',
      exec: 'este-binario-nao-existe-em-lugar-nenhum --x'
    });

    assert.equal(outcome.status, 'FAILED');
    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'FAILED');
  });
});

test('maxTasks stops the runner after the agreed number', async () => {
  await withProject({}, async service => {
    for (let i = 0; i < 5; i++) await service.createTask({ title: `t${i}`, createdBy: 'LEAD' });

    const outcomes = await runQueue(service, {
      agentId: 'WORKER',
      exec: `${NODE} -e "process.exit(0)"`,
      maxTasks: 2,
      intervalMs: 10
    });

    assert.equal(outcomes.length, 2);
    assert.equal((await service.tasks.list({ status: ['OPEN'] })).length, 3);
  });
});

test('exit 75 hands the task back to the queue and stops only that runner', async () => {
  // An agent out of quota may already have written correct code; failing the task would discard it.
  await withProject({}, async service => {
    const first = await service.createTask({ title: 'primeira', createdBy: 'LEAD' });
    await service.createTask({ title: 'segunda', createdBy: 'LEAD' });

    const outcomes = await runQueue(service, {
      agentId: 'WORKER',
      exec: `${NODE} -e "console.log('cota do dia acabou'); process.exit(75)"`
    });
    assert.equal(outcomes.length, 1, 'it stopped instead of claiming the next task to fail it too');

    const back = await service.tasks.read(first.id);
    assert.equal(back.status, 'OPEN');
    assert.equal(back.claimedBy, undefined);
    assert.match(back.result ?? '', /cota do dia acabou/);

    // Another agent picks it up and finishes it.
    await service.register('OTHER');
    const done = await runQueue(service, { agentId: 'OTHER', exec: `${NODE} -e "process.exit(0)"` });
    assert.deepEqual(done.map(o => o.status), ['DONE', 'DONE']);
    assert.equal((await service.tasks.read(first.id)).status, 'DONE');
  });
});
