import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentMemoryService } from '../src/core/service.js';
import { runQueue } from '../src/core/runner.js';
import { createMcpMethods } from '../src/mcp/server.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withProject(fn: (service: AgentMemoryService, root: string) => Promise<void>, claimSeconds = 1): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-own-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Ownership', { taskClaimSeconds: claimSeconds, autoCompactAfterEvents: 0 });
    await service.register('W1');
    await service.register('W2');
    await fn(service, root);
  } finally {
    // A killed child can hold the folder for a moment on Windows.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(50);
      }
    }
  }
}

/** A tool call as an MCP client makes it; `agent` pins the connection's identity. */
function mcp(service: AgentMemoryService, agent?: string) {
  const methods = createMcpMethods(service, agent ? { agentId: agent } : {});
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;
}

function cli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--root', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test('over MCP, an agent whose claim passed to another cannot finish the task', async () => {
  await withProject(async service => {
    const task = await service.createTask({ title: 'disputada', createdBy: 'W1' });
    const w1 = mcp(service, 'W1');
    assert.match((await w1('memory_task_claim')).content[0].text, new RegExp(`Claimed ${task.id}`));
    await sleep(1100);
    assert.equal((await service.claimTask('W2'))?.id, task.id, 'the lease ran out, so W2 takes it');

    const late = await w1('memory_task_finish', { id: task.id, status: 'DONE', result: 'resultado velho' });
    assert.equal(late.isError, true);
    assert.match(late.content[0].text, /held by W2.*not recorded/);
    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(stored.claimedBy, 'W2');

    // An unpinned connection names itself with `agent`; the holder's verdict is kept.
    const shared = mcp(service);
    const refused = await shared('memory_task_finish', { agent: 'W1', id: task.id, status: 'FAILED' });
    assert.equal(refused.isError, true);
    const verdict = await shared('memory_task_finish', { agent: 'W2', id: task.id, status: 'DONE', result: 'feito' });
    assert.equal(verdict.isError, undefined);
    assert.equal((await service.tasks.read(task.id)).result, 'feito');
  });
});

test('over MCP, finishing a task that already ended says the result was not recorded', async () => {
  await withProject(async service => {
    const task = await service.createTask({ title: 'ja fechada', createdBy: 'W1' });
    await service.claimTask('W2');
    await service.finishTask(task.id, 'DONE', 'feito', 'W2');

    const late = await mcp(service, 'W1')('memory_task_finish', { id: task.id, status: 'FAILED', result: 'tarde' });
    assert.equal(late.isError, true);
    assert.match(late.content[0].text, /already ended as DONE by W2; this result was not recorded/);
    assert.equal((await service.tasks.read(task.id)).result, 'feito');
  });
});

test('anyone may cancel a task another agent holds', async () => {
  await withProject(async service => {
    const task = await service.createTask({ title: 'cancelavel', createdBy: 'W1' });
    await service.claimTask('W1');
    const cancelled = await mcp(service, 'W2')('memory_task_finish', { id: task.id, status: 'CANCELLED' });
    assert.equal(cancelled.isError, undefined);
    assert.equal((await service.tasks.read(task.id)).status, 'CANCELLED');
  });
});

test('a heartbeat keeps the claim of an agent still working', async () => {
  await withProject(async service => {
    const task = await service.createTask({ title: 'longa', createdBy: 'W1' });
    await service.claimTask('W1');
    for (let elapsed = 0; elapsed < 1500; elapsed += 300) {
      await sleep(300);
      await service.heartbeat('W1');
    }
    assert.equal(await service.claimTask('W2'), undefined, 'W1 is alive, so the task is not handed out');
    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(stored.claimedBy, 'W1');
  });
});

test('the runner keeps its claim while the command runs past the lease', async () => {
  await withProject(async service => {
    const task = await service.createTask({ title: 'demorada', createdBy: 'W1' });
    const run = runQueue(service, {
      agentId: 'W1',
      exec: `"${process.execPath}" -e "setTimeout(()=>{}, 1800)"`,
      timeoutMs: 10_000,
      once: true
    });
    await sleep(1400);
    assert.equal(await service.claimTask('W2'), undefined, 'the runner renewed the claim');
    const [outcome] = await run;
    assert.equal(outcome.status, 'DONE');
    assert.equal((await service.tasks.read(task.id)).status, 'DONE');
  });
});

test('the CLI refuses a finish from an agent that no longer holds the task', async () => {
  await withProject(async (service, root) => {
    const task = await service.createTask({ title: 'disputada', createdBy: 'W1' });
    await service.claimTask('W1');
    await sleep(1100);
    await service.claimTask('W2');

    const late = await cli(root, ['task', 'done', '--id', task.id, '--agent', 'W1']);
    assert.notEqual(late.code, 0);
    assert.match(late.stderr, /held by W2/);
    assert.equal((await service.tasks.read(task.id)).claimedBy, 'W2');
  });
});

test('run refuses a timeout of 0 or one that reaches the claim lease', async () => {
  await withProject(async (_service, root) => {
    const none = await cli(root, ['run', '--agent', 'W1', '--exec', 'echo x', '--once', '--timeout', '0']);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /--timeout must be above 0/);
    const long = await cli(root, ['run', '--agent', 'W1', '--exec', 'echo x', '--once', '--timeout', '60']);
    assert.notEqual(long.code, 0);
    assert.match(long.stderr, /not below the claim lease of 60s/);
  }, 60);
});
