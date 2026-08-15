import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';
import { changedFiles, isGitRepo } from '../src/git/repo.js';
import { baselineOf, currentChanges, runWatchPass } from '../src/git/watcher.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await run('git', args, { cwd, windowsHide: true });
}

async function withRepo(fn: (service: AgentMemoryService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-git-'));
  try {
    await git(root, ['init', '-q', '.']);
    await git(root, ['config', 'user.email', 'watcher@test']);
    await git(root, ['config', 'user.name', 'Watcher Test']);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'Auth.cs'), 'line1\nline2\n', 'utf8');
    await writeFile(path.join(root, 'src', 'Orders.cs'), 'line1\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-qm', 'initial']);

    const service = new AgentMemoryService(root);
    await service.init('Watcher Project');
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('git status parsing covers modified, untracked, deleted and renamed paths', async () => {
  await withRepo(async (_service, root) => {
    assert.equal(await isGitRepo(root), true);

    await writeFile(path.join(root, 'src', 'Auth.cs'), 'line1\nCHANGED\nline3\n', 'utf8');
    await writeFile(path.join(root, 'src', 'New File.cs'), 'new\n', 'utf8');
    await git(root, ['mv', 'src/Orders.cs', 'src/Sales.cs']);

    const changes = await changedFiles(root);
    const byPath = new Map(changes.map(c => [c.path, c]));

    const modified = byPath.get('src/Auth.cs')!;
    assert.equal(modified.kind, 'modified');
    assert.equal(modified.insertions, 2);
    assert.equal(modified.deletions, 1);

    // A path with a space must survive the NUL-delimited parse.
    assert.equal(byPath.get('src/New File.cs')!.kind, 'untracked');

    const renamed = byPath.get('src/Sales.cs')!;
    assert.equal(renamed.kind, 'renamed');
    assert.equal(renamed.from, 'src/Orders.cs', 'the rename source is the record that follows');
  });
});

test('the coordination directory is never reported as project work', async () => {
  await withRepo(async (_service, root) => {
    // .agents/ exists from init() and is untracked here.
    const raw = await changedFiles(root);
    assert.ok(raw.some(c => c.path.startsWith('.agents/')), 'git does see it');

    const filtered = await currentChanges(root);
    assert.equal(filtered.filter(c => c.path.startsWith('.agents/')).length, 0);
  });
});

test('a change is credited to the single agent pointing at that file', async () => {
  await withRepo(async (service, root) => {
    await service.register('AGENT-01');
    await service.activity({
      agentId: 'AGENT-01',
      type: 'INTENT',
      description: 'validar token',
      pointer: parsePointer('src/Auth.cs::Auth.Validate()')
    });

    const seen = await baselineOf(root);
    await writeFile(path.join(root, 'src', 'Auth.cs'), 'line1\nCHANGED\n', 'utf8');

    const result = await runWatchPass(service, seen);
    assert.equal(result.observed.length, 1);
    assert.equal(result.observed[0].attribution, 'declared');
    assert.equal(result.observed[0].agentId, 'AGENT-01');

    const events = await service.store.recentActivities(5);
    assert.equal(events[0].type, 'OBSERVED');
    assert.equal(events[0].agentId, 'AGENT-01');
    assert.match(events[0].description, /git: modified/);

    // The observation must not overwrite what the agent declared it was doing.
    const state = await service.store.readState('AGENT-01');
    assert.equal(state.current?.description, 'validar token');
    assert.equal(state.status, 'WORKING');
  });
});

test('a change nobody claimed is reported as undeclared and kept out of any agent history', async () => {
  await withRepo(async (service, root) => {
    await service.register('AGENT-01');
    await service.activity({
      agentId: 'AGENT-01',
      type: 'INTENT',
      description: 'mexendo em auth',
      pointer: parsePointer('src/Auth.cs::Auth.Validate()')
    });

    const seen = await baselineOf(root);
    await writeFile(path.join(root, 'src', 'Orders.cs'), 'line1\nsurpresa\n', 'utf8');

    const result = await runWatchPass(service, seen);
    assert.equal(result.undeclared, 1);
    assert.equal(result.observed[0].attribution, 'undeclared');
    assert.equal(result.observed[0].agentId, undefined);

    const events = await service.store.recentActivities(5);
    assert.equal(events[0].agentId, 'GIT-WATCHER');
    assert.match(events[0].description, /not declared by any agent/);

    const history = await service.store.listHistoryAgents();
    assert.deepEqual(history, ['AGENT-01'], 'the watcher must not open a history for a non-agent');
  });
});

test('two agents claiming the same file make the change ambiguous, not guessed', async () => {
  await withRepo(async (service, root) => {
    const pointer = parsePointer('src/Auth.cs::Auth.Validate()');
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await service.activity({ agentId: 'AGENT-01', type: 'INTENT', description: 'a', pointer });
    await service.activity({ agentId: 'AGENT-02', type: 'INTENT', description: 'b', pointer });

    const seen = await baselineOf(root);
    await writeFile(path.join(root, 'src', 'Auth.cs'), 'x\n', 'utf8');

    const result = await runWatchPass(service, seen);
    assert.equal(result.ambiguous, 1);
    assert.deepEqual(result.observed[0].candidates, ['AGENT-01', 'AGENT-02']);
    assert.equal(result.observed[0].agentId, undefined);

    const events = await service.store.recentActivities(5);
    assert.match(events[0].description, /claimed by more than one agent \(AGENT-01, AGENT-02\)/);
  });
});

test('attribution falls back to the journal when the agent has moved on', async () => {
  await withRepo(async (service, root) => {
    await service.register('AGENT-01');
    await service.activity({
      agentId: 'AGENT-01',
      type: 'CHANGED',
      description: 'mexeu em auth',
      pointer: parsePointer('src/Auth.cs::Auth.Validate()')
    });
    // The agent is now pointing somewhere else entirely.
    await service.activity({
      agentId: 'AGENT-01',
      type: 'INTENT',
      description: 'agora em orders',
      pointer: parsePointer('src/Orders.cs::OrderService.Cancel()')
    });

    const seen = await baselineOf(root);
    await writeFile(path.join(root, 'src', 'Auth.cs'), 'x\n', 'utf8');

    const result = await runWatchPass(service, seen);
    assert.equal(result.observed[0].attribution, 'declared');
    assert.equal(result.observed[0].agentId, 'AGENT-01');
  });
});

test('a pass reports each change once, then again only when it changes further', async () => {
  await withRepo(async (service, root) => {
    const seen = await baselineOf(root);
    const file = path.join(root, 'src', 'Auth.cs');

    await writeFile(file, 'one\n', 'utf8');
    assert.equal((await runWatchPass(service, seen)).observed.length, 1);
    assert.equal((await runWatchPass(service, seen)).observed.length, 0, 'unchanged tree is silent');

    await writeFile(file, 'one\ntwo\n', 'utf8');
    assert.equal((await runWatchPass(service, seen)).observed.length, 1, 'further edits are reported');

    // Reverting drops the path so a later edit is reported again rather than swallowed.
    await git(root, ['checkout', '--', 'src/Auth.cs']);
    await runWatchPass(service, seen);
    assert.equal(seen.has('src/Auth.cs'), false);

    await writeFile(file, 'again\n', 'utf8');
    assert.equal((await runWatchPass(service, seen)).observed.length, 1);
  });
});

test('dry run reports without writing anything to the journal', async () => {
  await withRepo(async (service, root) => {
    const before = await service.store.countEvents();
    const seen = await baselineOf(root);
    await writeFile(path.join(root, 'src', 'Auth.cs'), 'x\n', 'utf8');

    const result = await runWatchPass(service, seen, { record: false });
    assert.equal(result.observed.length, 1);
    assert.equal(await service.store.countEvents(), before);
  });
});
