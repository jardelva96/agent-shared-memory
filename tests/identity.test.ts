import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { assertAgentId } from '../src/utils/ids.js';

async function withProject(fn: (service: AgentMemoryService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-id-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Identity Project');
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('agent ids are validated, never rewritten into a safe name', () => {
  for (const good of ['AGENT-01', 'agent_02', 'a.b-c_1', 'X']) {
    assert.equal(assertAgentId(good), good);
  }
  assert.equal(assertAgentId('  AGENT-01  '), 'AGENT-01', 'surrounding space is trimmed');

  // Anything that would collapse onto another id must be refused outright.
  const backslash = String.fromCharCode(92);
  for (const bad of [
    'AGENT/01',
    `AGENT${backslash}01`,
    'AGENT:01',
    'a b',
    '../escape',
    '..',
    '.',
    '',
    '   ',
    '-.-'
  ]) {
    assert.throws(() => assertAgentId(bad), /Invalid agent id|must not be empty/, `${JSON.stringify(bad)} was accepted`);
  }
});

test('an id that would alias another agent cannot delete its state', async () => {
  await withProject(async (service, root) => {
    await service.register('AGENT-01', 'Backend', 'AUTH-184');
    await service.activity({ agentId: 'AGENT-01', type: 'CHANGED', description: 'trabalho importante' });

    // Before validation this deleted AGENT-01's state file.
    await assert.rejects(() => service.unregister('AGENT/01'), /Invalid agent id/);

    const states = await service.states();
    assert.deepEqual(states.map(s => s.id), ['AGENT-01'], 'the real agent survives');
    assert.equal(states[0].current?.description, 'trabalho importante');

    const files = await readdir(path.join(root, '.agents', 'state'));
    assert.deepEqual(files, ['AGENT-01.json'], 'no aliased file was created');
  });
});

test('an aliasing id cannot read or write another agent state', async () => {
  await withProject(async service => {
    await service.register('AGENT-02');
    await assert.rejects(() => service.store.readState('AGENT:02'), /Invalid agent id/);
    await assert.rejects(() => service.heartbeat('AGENT/02'), /Invalid agent id/);
    await assert.rejects(
      () => service.activity({ agentId: 'AGENT:02', type: 'NOTE', description: 'x' }),
      /Invalid agent id/
    );
  });
});

test('an invalid recipient cannot be used to reach another inbox', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await assert.rejects(
      () => service.sendMessage({ from: 'AGENT-01', to: 'AGENT:02', body: 'desviada' }),
      /Invalid agent id/
    );
    assert.equal(await service.messages.unreadCount('AGENT-02'), 0);
  });
});

test('compact trims read messages but never unread ones', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    for (let i = 0; i < 30; i++) {
      await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: `msg ${i}` });
    }

    // Nothing read yet: a trim must not touch a single message.
    const untouched = await service.compact({ keep: 5 });
    assert.deepEqual(untouched.messagesTrimmed, [], 'unread messages are never dropped');
    assert.equal((await service.messages.list('AGENT-02')).length, 30);

    // Read them all, then compact again.
    await service.readInbox('AGENT-02');
    const trimmed = await service.compact({ keep: 5 });
    assert.deepEqual(trimmed.messagesTrimmed, [{ agent: 'AGENT-02', removed: 25 }]);

    const remaining = await service.messages.list('AGENT-02');
    assert.equal(remaining.length, 5);
    assert.equal(remaining[4].body, 'msg 29', 'the newest message survives');
    assert.equal(await service.messages.unreadCount('AGENT-02'), 0, 'the read cursor still resolves');

    // New mail after a trim is still delivered and counted.
    await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: 'depois do corte' });
    assert.equal(await service.messages.unreadCount('AGENT-02'), 1);
  });
});

test('a partially read inbox only loses the read prefix', async () => {
  await withProject(async service => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    for (let i = 0; i < 10; i++) {
      await service.sendMessage({ from: 'AGENT-01', to: 'AGENT-02', body: `msg ${i}` });
    }
    // Acknowledge only the first four.
    const all = await service.messages.list('AGENT-02');
    await service.messages.markRead('AGENT-02', all[3].id);

    await service.compact({ keep: 2 });
    const remaining = await service.messages.list('AGENT-02');
    assert.equal(remaining.length, 6, 'the six unread messages are kept even though keep=2');
    assert.equal(remaining[0].body, 'msg 4');
    assert.equal(await service.messages.unreadCount('AGENT-02'), 6);
  });
});
