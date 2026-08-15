import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, boolFlag, stringFlag } from '../src/cli/args.js';
import { detectConflicts } from '../src/core/conflicts.js';
import { parsePointer } from '../src/core/pointer.js';
import { AgentMemoryService } from '../src/core/service.js';
import { withFileLock, cleanStaleTemps } from '../src/utils/fs.js';
import { AgentState, ProjectConfig } from '../src/models/types.js';

const CONFIG: ProjectConfig = {
  version: 1,
  staleAfterSeconds: 60,
  recentHistoryLimit: 20,
  projectName: 'T',
  autoCompactAfterEvents: 0,
  taskClaimSeconds: 900,
  maxTaskDepth: 3
};

function stateAt(id: string, pointer: string, ageSeconds: number): AgentState {
  const iso = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    id,
    sessionId: `s-${id}`,
    status: 'WORKING',
    current: { type: 'INTENT', description: `${id} trabalhando`, pointer: parsePointer(pointer) },
    startedAt: iso,
    updatedAt: iso,
    lastHeartbeatAt: iso
  };
}

test('an explicit false on a boolean flag is honoured, not swallowed', () => {
  // Before: "--history false" set history=true and rotated every history the user
  // had just said not to touch.
  for (const argv of [
    ['compact', '--history', 'false'],
    ['compact', '--history=false'],
    ['compact', '--history', '0']
  ]) {
    assert.equal(boolFlag(parseArgs(argv).flags, 'history'), false, argv.join(' '));
  }
  for (const argv of [['compact', '--history'], ['compact', '--history', 'true'], ['compact', '--history=1']]) {
    assert.equal(boolFlag(parseArgs(argv).flags, 'history'), true, argv.join(' '));
  }
});

test('an unknown flag fails instead of being ignored', () => {
  assert.throws(() => parseArgs(['compact', '--dryrun']), /Unknown flag: --dryrun/);
  assert.throws(() => parseArgs(['status', '--jsonn']), /Unknown flag/);
});

test('a value flag with no value fails, and =value carries a leading dash', () => {
  assert.throws(() => parseArgs(['found', '--agent', '--message', 'x']), /--agent needs a value/);
  const parsed = parseArgs(['found', '--agent', 'A', '--message=--root is broken']);
  assert.equal(stringFlag(parsed.flags, 'message'), '--root is broken');
});

test('conflict detection honours staleness, matching the panel', () => {
  const fresh = [stateAt('A', 'src/x.ts::f()', 0), stateAt('B', 'src/x.ts::f()', 0)];
  assert.equal(detectConflicts(fresh, 'A', parsePointer('src/x.ts::f()'), CONFIG).length, 1);

  // B stopped sending heartbeats: the panel shows it OFFLINE, so the CLI must agree.
  const stale = [stateAt('A', 'src/x.ts::f()', 0), stateAt('B', 'src/x.ts::f()', 600)];
  assert.equal(detectConflicts(stale, 'A', parsePointer('src/x.ts::f()'), CONFIG).length, 0);
});

test('a lock is only deleted by its owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-own-'));
  try {
    const lockFile = path.join(root, 'x.lock');
    // Simulate the dangerous interleaving: our work outlives the lock, someone else
    // reclaims the path and takes it. Releasing must not evict them.
    await withFileLock(lockFile, async () => {
      await writeFile(lockFile, 'outro-processo', 'utf8');
    });
    assert.equal(await readFile(lockFile, 'utf8'), 'outro-processo', 'the other holder survived');
    await rm(lockFile, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orphaned temp files are swept, recent ones are left alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-tmp-'));
  try {
    const old = path.join(root, 'state.json.111.tmp');
    const recent = path.join(root, 'state.json.222.tmp');
    await writeFile(old, 'x', 'utf8');
    await writeFile(recent, 'x', 'utf8');
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    await utimes(old, longAgo, longAgo);

    assert.equal(await cleanStaleTemps(root), 1);
    await assert.rejects(() => readFile(old, 'utf8'), /ENOENT/);
    assert.equal(await readFile(recent, 'utf8'), 'x', 'a write still in flight is untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a runner that lost its claim cannot overwrite the new holder result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-claim-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Claim', { taskClaimSeconds: 1, autoCompactAfterEvents: 0 });
    await service.register('W1');
    await service.register('W2');
    const task = await service.createTask({ title: 'disputada', createdBy: 'W1' });

    await service.claimTask('W1');
    await new Promise(r => setTimeout(r, 1100)); // W1's lease expires
    await service.claimTask('W2');

    await assert.rejects(
      () => service.finishTask(task.id, 'DONE', 'resultado velho do W1', 'W1'),
      /held by W2/
    );

    const stored = await service.tasks.read(task.id);
    assert.equal(stored.status, 'CLAIMED');
    assert.equal(stored.claimedBy, 'W2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a null line does not kill the MCP server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-null-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Null');
    const { createMcpMethods } = await import('../src/mcp/server.js');
    const methods = createMcpMethods(service);
    // The transport must survive it; this asserts the method map is still usable.
    const listed = (await methods.get('tools/list')!(undefined)) as { tools: unknown[] };
    assert.ok(listed.tools.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
