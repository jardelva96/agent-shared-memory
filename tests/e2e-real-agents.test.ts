import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'cli', 'main.ts');
const AGENT = path.join(here, 'helpers', 'recursive-app-agent.mjs');
const AGENT_CMD = `node ${AGENT.replaceAll('\\', '/')}`;

function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--root', root, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test('local CLI runners execute a recursive agent chain that builds a real fullstack app', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-e2e-agents-'));
  try {
    assert.equal((await cli(root, ['init', '--name', 'Recursive E2E'])).code, 0);
    assert.equal((await cli(root, ['config', '--max-depth', '8'])).code, 0);
    assert.equal((await cli(root, ['register', '--agent', 'LEAD'])).code, 0);
    assert.equal((await cli(root, ['register', '--agent', 'AGENT-0'])).code, 0);

    const created = await cli(root, [
      'task',
      'create',
      '--agent',
      'LEAD',
      '--for',
      'AGENT-0',
      '--title',
      'build fullstack layer 0',
      '--detail',
      'Create a fullstack app and spawn the next local agent.',
      '--json'
    ]);
    assert.equal(created.code, 0, created.stderr);
    assert.match(JSON.parse(created.stdout).id, /^T-/);

    for (let depth = 0; depth <= 7; depth++) {
      const agent = `AGENT-${depth}`;
      const run = await cli(
        root,
        ['run', '--agent', agent, '--exec', AGENT_CMD, '--once', '--timeout', '15'],
        { AGENT_MEMORY_CLI: CLI, AGENT_MEMORY_REPO: path.join(here, '..') }
      );
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /done T-/);
    }

    const tasks = JSON.parse((await cli(root, ['task', 'list', '--json'])).stdout);
    assert.equal(tasks.length, 8);
    assert.deepEqual(
      tasks.map((task: { status: string; depth: number }) => [task.status, task.depth]),
      [
        ['DONE', 0],
        ['DONE', 1],
        ['DONE', 2],
        ['DONE', 3],
        ['DONE', 4],
        ['DONE', 5],
        ['DONE', 6],
        ['DONE', 7]
      ]
    );
    for (let depth = 0; depth <= 7; depth++) {
      assert.match(tasks[depth].result, new RegExp(`agent AGENT-${depth} wrote`));
    }

    const appRoot = path.join(root, 'app');
    const pkg = await readFile(path.join(appRoot, 'package.json'), 'utf8');
    const server = await readFile(path.join(appRoot, 'server.js'), 'utf8');
    const html = await readFile(path.join(appRoot, 'public', 'index.html'), 'utf8');
    const js = await readFile(path.join(appRoot, 'public', 'app.js'), 'utf8');
    const css = await readFile(path.join(appRoot, 'public', 'styles.css'), 'utf8');
    const seed = await readFile(path.join(appRoot, 'data', 'tasks.json'), 'utf8');
    const apiTest = await readFile(path.join(appRoot, 'test', 'api.test.mjs'), 'utf8');
    const readme = await readFile(path.join(root, 'app', 'README.md'), 'utf8');

    assert.match(pkg, /agent-built-fullstack/);
    assert.match(server, /createServer/);
    assert.match(html, /Agent Ops/);
    assert.match(js, /fetch\(path/);
    assert.match(css, /font-family:system-ui/);
    assert.match(seed, /Ship the agent-built fullstack app/);
    assert.match(apiTest, /persists tasks/);
    assert.match(readme, /complete local fullstack/);

    const appTest = spawnSync(process.execPath, ['--test', 'test/api.test.mjs'], {
      cwd: appRoot,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(appTest.status, 0, appTest.stderr || appTest.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
