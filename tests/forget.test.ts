import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { runClaudeHook } from '../src/cli/hooks.js';

const HOUR = 3_600_000;

async function withProject(fn: (service: AgentMemoryService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-forget-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Forget');
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Makes a session look silent since `hours` ago, as a Claude Code window closed without SessionEnd does. */
async function silentFor(service: AgentMemoryService, id: string, hours: number): Promise<void> {
  const state = await service.store.readState(id);
  await service.store.writeState({ ...state, lastHeartbeatAt: new Date(Date.now() - hours * HOUR).toISOString() });
}

const ids = async (service: AgentMemoryService) => (await service.store.listStates()).map(s => s.id).sort();

test('a session silent for two days is forgotten, and its history stays', async () => {
  await withProject(async (service, root) => {
    await service.register('OLD');
    await service.register('LIVE');
    await silentFor(service, 'OLD', 48);

    assert.deepEqual(await service.forgetIdleSessions(), ['OLD']);
    assert.deepEqual(await ids(service), ['LIVE']);
    await access(path.join(root, '.agents', 'history', 'OLD.md'));
    const journal = (await service.store.recentActivities(20)).map(e => `${e.agentId} ${e.description}`);
    assert.ok(journal.includes('OLD Forgotten after 24 h offline; history preserved.'), journal.join('\n'));
  });
});

test('a silent session that holds a claimed task or a reservation is kept', async () => {
  await withProject(async service => {
    await service.register('LEAD');
    await service.register('WORKER');
    await service.register('HOLDER');
    await service.createTask({ createdBy: 'LEAD', title: 'long job', assignedTo: 'WORKER' });
    assert.ok(await service.claimTask('WORKER'));
    await service.reserve('HOLDER', ['src/a.ts'], { ttlSeconds: 3600 });
    await silentFor(service, 'WORKER', 48);
    await silentFor(service, 'HOLDER', 48);

    assert.deepEqual(await service.forgetIdleSessions(), []);
    assert.deepEqual(await ids(service), ['HOLDER', 'LEAD', 'WORKER']);
  });
});

test('forgetOfflineAfterHours 0 keeps every session', async () => {
  await withProject(async service => {
    await service.updateConfig({ forgetOfflineAfterHours: 0 });
    await service.register('OLD');
    await silentFor(service, 'OLD', 24 * 30);

    assert.deepEqual(await service.forgetIdleSessions({ force: true }), []);
    assert.deepEqual(await ids(service), ['OLD']);
  });
});

test('the sweep runs at most once an hour unless forced', async () => {
  await withProject(async service => {
    await service.register('A');
    await silentFor(service, 'A', 30);
    assert.deepEqual(await service.forgetIdleSessions(), ['A']);

    await service.register('B');
    await silentFor(service, 'B', 30);
    assert.deepEqual(await service.forgetIdleSessions(), [], 'a second sweep within the hour does nothing');
    assert.deepEqual(await service.forgetIdleSessions({ now: new Date(Date.now() + HOUR + 1000) }), ['B']);
  });
});

test('a session start forgets the silent sessions before the briefing names anyone', async () => {
  await withProject(async (service, root) => {
    await service.register('CC-DEADBEEF');
    await silentFor(service, 'CC-DEADBEEF', 72);

    const out = await runClaudeHook('session-start', JSON.stringify({ session_id: 'abc', cwd: root }), { AGENT_MEMORY_AGENT: 'NEW' });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(await ids(service), ['NEW']);
    assert.doesNotMatch(String(out.stdout), /CC-DEADBEEF/);
  });
});
