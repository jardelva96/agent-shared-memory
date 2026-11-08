import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';

async function withProject(fn: (service: AgentMemoryService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-brief-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Briefing');
    await fn(service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lineOf = (text: string, id: string) => text.split('\n').find(l => l.startsWith(`- ${id}:`)) ?? '';

test('the briefing says where each active session works and when it was last seen', async () => {
  await withProject(async service => {
    await service.register('ME');
    await service.register('OTHER');
    await service.notePlaces('OTHER', ['GameBoost']);
    await service.notePlaces('OTHER', ['jva-editora']);

    const line = lineOf(await service.prime('ME'), 'OTHER');
    assert.match(line, / \[in (jva-editora, GameBoost|GameBoost, jva-editora); last activity just now\]$/, line);
  });
});

test('an edit counts as working in the folder of the file', async () => {
  await withProject(async service => {
    await service.register('ME');
    await service.register('EDITOR');
    await service.activity({ agentId: 'EDITOR', type: 'INTENT', description: 'Edit web/src/app.ts', pointer: { file: 'web/src/app.ts' } });

    assert.match(lineOf(await service.prime('ME'), 'EDITOR'), /\(web\/src\/app\.ts\) \[in web; last activity just now\]$/);
  });
});

test('a session that touched nothing yet says so', async () => {
  await withProject(async service => {
    await service.register('ME');
    await service.register('NEW');

    assert.match(lineOf(await service.prime('ME'), 'NEW'), /: Registered and ready\. \[no files touched yet; last activity just now\]$/);
  });
});

test('only recent places count, so an old folder does not look busy', async () => {
  await withProject(async service => {
    await service.register('ME');
    await service.register('OTHER');
    const state = await service.store.readState('OTHER');
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    await service.store.writeState({ ...state, places: { 'old-repo': hoursAgo(5), 'new-repo': new Date().toISOString() } });

    const line = lineOf(await service.prime('ME'), 'OTHER');
    assert.match(line, /\[in new-repo;/, line);
    assert.doesNotMatch(line, /old-repo/);
  });
});
