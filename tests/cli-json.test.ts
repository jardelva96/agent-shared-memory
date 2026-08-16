import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');

function cli(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--root', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.on('exit', code => resolve({ code: code ?? -1, stdout: stdout.trim() }));
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
