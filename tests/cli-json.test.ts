import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');

function cli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--root', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test('task create --json answers with the task, so a chain can be scripted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-cli-'));
  try {
    await cli(root, ['init', '--name', 'Chain']);
    await cli(root, ['register', '--agent', 'LEAD']);

    const created = await cli(root, ['task', 'create', '--agent', 'LEAD', '--title', 'parte A', '--json']);
    const task = JSON.parse(created.stdout);
    assert.match(task.id, /^T-/, 'the id is what --depends-on needs');
    assert.equal(task.title, 'parte A');
    assert.equal(task.status, 'OPEN');

    // The printed id has to be usable as a dependency without parsing a sentence.
    const gather = await cli(root, [
      'task', 'create', '--agent', 'LEAD', '--title', 'juntar', '--depends-on', task.id, '--json'
    ]);
    assert.deepEqual(JSON.parse(gather.stdout).dependsOn, [task.id]);

    const plain = await cli(root, ['task', 'create', '--agent', 'LEAD', '--title', 'parte B']);
    assert.match(plain.stdout, /^Queued T-/, 'without the flag it still reads like a sentence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task create rejects invalid reviewer panel sizes without writing a task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-cli-'));
  try {
    await cli(root, ['init', '--name', 'Panel']);
    await cli(root, ['register', '--agent', 'LEAD']);

    const bad = await cli(root, ['task', 'create', '--agent', 'LEAD', '--title', 'x', '--reviewers', '0']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /positive integer/);

    const listed = await cli(root, ['task', 'list', '--json']);
    assert.deepEqual(JSON.parse(listed.stdout), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task done on a task that already failed is refused, and says what to do instead', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-cli-'));
  try {
    await cli(root, ['init', '--name', 'Verdict']);
    await cli(root, ['register', '--agent', 'LEAD']);
    const id = JSON.parse((await cli(root, ['task', 'create', '--agent', 'LEAD', '--title', 'x', '--json'])).stdout).id;
    assert.equal((await cli(root, ['task', 'fail', '--id', id])).code, 0);

    // Real use, 2026-11-08: this printed "is now FAILED", which read as if done had changed it.
    const done = await cli(root, ['task', 'done', '--id', id]);
    assert.notEqual(done.code, 0);
    assert.match(done.stderr, new RegExp(`${id} already ended as FAILED; a finished task never changes.*Same as ${id}`));
    assert.doesNotMatch(done.stdout, /is now/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run --once --max-tasks 1 runs exactly one task, and --once alone runs every ready one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-cli-'));
  try {
    await cli(root, ['init', '--name', 'Once']);
    await cli(root, ['register', '--agent', 'LEAD']);
    await cli(root, ['register', '--agent', 'W']);
    for (const title of ['a', 'b', 'c']) await cli(root, ['task', 'create', '--agent', 'LEAD', '--title', title]);

    // Real use, 2026-11-08: --once dropped --max-tasks, and a run meant for one task ran three.
    const one = await cli(root, ['run', '--agent', 'W', '--exec', 'node -e 0', '--once', '--max-tasks', '1']);
    assert.match(one.stdout, /^1 task\(s\) executed\.$/m, one.stdout + one.stderr);
    const rest = await cli(root, ['run', '--agent', 'W', '--exec', 'node -e 0', '--once']);
    assert.match(rest.stdout, /^2 task\(s\) executed\.$/m, rest.stdout + rest.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
