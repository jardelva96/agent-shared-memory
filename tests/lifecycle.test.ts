import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';
import { withFileLock } from '../src/utils/fs.js';

async function withProject(fn: (service: AgentMemoryService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-life-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Lifecycle Project');
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('register refuses a duplicate id and points at the escape hatch', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await assert.rejects(() => service.register('AGENT-01'), /already exists.*--force/s);
  });
});

test('reset starts a new session and keeps the history file', async () => {
  await withProject(async (service, root) => {
    const first = await service.register('AGENT-01', 'Backend', 'AUTH-184');
    await service.activity({
      agentId: 'AGENT-01',
      type: 'CHANGED',
      description: 'Validação adicionada.',
      pointer: parsePointer('src/Auth.cs::Auth.Validate()')
    });

    const second = await service.reset('AGENT-01');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.status, 'ONLINE');
    assert.equal(second.task, 'AUTH-184', 'demand carries over when not overridden');
    assert.equal(second.role, 'Backend');
    assert.equal(second.current?.type, 'REGISTERED');

    const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(history, /Validação adicionada/, 'previous work must survive a reset');
  });
});

test('unregister removes the agent from the panel but preserves its history', async () => {
  await withProject(async (service, root) => {
    await service.register('AGENT-01');
    await service.activity({ agentId: 'AGENT-01', type: 'DONE', description: 'Demanda concluída.' });

    await service.unregister('AGENT-01');

    assert.deepEqual(await service.states(), []);
    const memory = await service.store.readSharedMemory();
    assert.doesNotMatch(memory, /### AGENT-01/);

    const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(history, /Demanda concluída/);

    const events = await service.store.recentActivities(10);
    assert.equal(events[0].type, 'UNREGISTERED');

    await assert.rejects(() => service.unregister('AGENT-01'), /not registered/);
  });
});

test('a re-registered id starts clean but appends to the same history', async () => {
  await withProject(async (service, root) => {
    await service.register('AGENT-01', 'Backend');
    await service.activity({ agentId: 'AGENT-01', type: 'CHANGED', description: 'Primeira passagem.' });
    await service.unregister('AGENT-01');

    const revived = await service.register('AGENT-01', 'Frontend');
    assert.equal(revived.role, 'Frontend');
    assert.equal(revived.status, 'ONLINE');

    const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(history, /Primeira passagem/, 'register must not wipe an existing history');
  });
});

test('compact archives old events and leaves the newest window in place', async () => {
  await withProject(async (service, root) => {
    await service.register('AGENT-01');
    for (let i = 0; i < 12; i++) {
      await service.activity({ agentId: 'AGENT-01', type: 'NOTE', description: `nota ${i}` });
    }
    const before = await service.store.countEvents();
    assert.equal(before, 13, 'one REGISTERED plus twelve notes');

    const dry = await service.compact({ keep: 5, dryRun: true });
    assert.equal(dry.eventsArchived, 8);
    assert.equal(await service.store.countEvents(), 13, 'dry run must not write');

    const result = await service.compact({ keep: 5 });
    assert.equal(result.eventsArchived, 8);
    assert.equal(await service.store.countEvents(), 5);

    const kept = await service.store.recentActivities(10);
    assert.equal(kept.length, 5);
    assert.equal(kept[0].description, 'nota 11', 'newest event survives');

    const archived = await readFile(result.eventsArchiveFile!, 'utf8');
    assert.equal(archived.split('\n').filter(Boolean).length, 8);
    assert.match(archived, /nota 0/);

    const archiveDir = await readdir(path.join(root, '.agents', 'events', 'archive'));
    assert.equal(archiveDir.length, 1);
  });
});

test('compact is a no-op when the journal is under the keep threshold', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    const result = await service.compact({ keep: 500 });
    assert.equal(result.eventsArchived, 0);
    assert.equal(result.eventsArchiveFile, undefined);
    assert.equal(await service.store.countEvents(), 1);
  });
});

test('compact --history rotates each history and leaves a pointer to the archive', async () => {
  await withProject(async (service, root) => {
    await service.register('AGENT-01', 'Backend');
    await service.activity({ agentId: 'AGENT-01', type: 'CHANGED', description: 'Trabalho antigo.' });

    const result = await service.compact({ keep: 0, history: true });
    assert.equal(result.historyArchived.length, 1);
    assert.equal(result.historyArchived[0].agent, 'AGENT-01');

    const fresh = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(fresh, /# AGENT-01/, 'header is rebuilt');
    assert.match(fresh, /Earlier entries archived in archive\//);
    assert.doesNotMatch(fresh, /Trabalho antigo/);

    const archived = await readFile(result.historyArchived[0].file, 'utf8');
    assert.match(archived, /Trabalho antigo/);

    // The rotated file must still accept new entries.
    await service.activity({ agentId: 'AGENT-01', type: 'NOTE', description: 'Trabalho novo.' });
    const after = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
    assert.match(after, /Trabalho novo/);
  });
});

test('an abandoned lock is reclaimed instead of wedging the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-lock-'));
  try {
    const lockFile = path.join(root, 'stale.lock');
    await writeFile(lockFile, '', 'utf8');
    // Backdate the lock past the staleness window, simulating a crashed process.
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);

    const value = await withFileLock(lockFile, async () => 'acquired', 500);
    assert.equal(value, 'acquired');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fresh lock held by a live process still blocks and times out', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-lock2-'));
  try {
    const lockFile = path.join(root, 'held.lock');
    await writeFile(lockFile, '', 'utf8');
    await assert.rejects(() => withFileLock(lockFile, async () => 'nope', 200), /Timed out waiting for lock/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
