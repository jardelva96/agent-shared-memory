import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentMemoryService } from '../src/core/service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'helpers', 'concurrent-agent.ts');

const AGENTS = 6;
const STEPS = 6;

function runAgent(root: string, agentId: string, steps: number): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, root, agentId, String(steps)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => resolve({ code: code ?? -1, stderr: stderr.trim() }));
  });
}

test('independent processes writing at once lose nothing and corrupt nothing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-conc-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Concurrency Project');
    const ids = Array.from({ length: AGENTS }, (_, i) => `AGENT-${String(i + 1).padStart(2, '0')}`);

    const results = await Promise.all(ids.map(id => runAgent(root, id, STEPS)));
    const failures = results.filter(r => r.code !== 0);
    assert.deepEqual(failures.map(f => f.stderr), [], 'no agent process may die under contention');

    // The journal must hold every REGISTERED plus every activity, all parseable. The agents
    // share two files, so the system also journals the overlap notices it sends them; those
    // are counted apart, since how many arrive depends on how the processes interleave.
    const journal = await readFile(path.join(root, '.agents', 'events', 'events.jsonl'), 'utf8');
    const lines = journal
      .split('\n')
      .filter(Boolean)
      .filter(line => (JSON.parse(line) as { type: string }).type !== 'MESSAGE');
    const perAgent = new Map<string, number>();
    for (const line of lines) {
      const event = JSON.parse(line) as { agentId: string };
      perAgent.set(event.agentId, (perAgent.get(event.agentId) ?? 0) + 1);
    }
    assert.equal(lines.length, AGENTS * (STEPS + 1), 'no event was lost to an interleaved append');
    for (const id of ids) assert.equal(perAgent.get(id), STEPS + 1, `${id} wrote all of its events`);

    // Every state file must survive concurrent atomic writes intact.
    const stateFiles = (await readdir(path.join(root, '.agents', 'state'))).filter(f => f.endsWith('.json'));
    assert.equal(stateFiles.length, AGENTS);
    for (const file of stateFiles) {
      JSON.parse(await readFile(path.join(root, '.agents', 'state', file), 'utf8'));
    }

    // A failed rename would leave a temp file behind pretending to be state.
    const strays = (await readdir(path.join(root, '.agents', 'state'))).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(strays, [], 'no orphaned temp files');

    // Histories must be complete and must never receive another agent's entries.
    for (const id of ids) {
      const history = await readFile(path.join(root, '.agents', 'history', `${id}.md`), 'utf8');
      assert.equal((history.match(/^## \d{4}-/gm) ?? []).length, STEPS + 1, `${id} history is complete`);
      for (const other of ids) {
        if (other !== id) assert.doesNotMatch(history, new RegExp(`${other} step`), 'no cross-talk');
      }
    }

    // Locks are released even when contended.
    const locks = (await readdir(path.join(root, '.agents', '.locks')).catch(() => [])).filter(f =>
      f.endsWith('.lock')
    );
    assert.deepEqual(locks, [], 'no lock left held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a contended panel lock never fails the write it follows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-panel-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Contended Project');
    await service.register('AGENT-01');

    // Hold the shared-memory lock the way a live process would: recent enough that the
    // stale-lock reclaimer leaves it alone.
    const lockFile = path.join(root, '.agents', '.locks', 'shared-memory.lock');
    const held = await open(lockFile, 'w');
    const keepFresh = setInterval(() => void held.utimes(new Date(), new Date()), 500);

    try {
      const result = await service.activity({
        agentId: 'AGENT-01',
        type: 'CHANGED',
        description: 'escreveu com o painel travado',
        pointer: { file: 'src/Auth.cs', symbol: 'Auth.Validate()' }
      });

      // The panel could not be regenerated, but the write itself must be durable.
      assert.equal(result.state.status, 'WORKING');
      const state = await service.store.readState('AGENT-01');
      assert.equal(state.current?.description, 'escreveu com o painel travado');

      const events = await service.store.recentActivities(5);
      assert.equal(events[0].description, 'escreveu com o painel travado');

      const history = await readFile(path.join(root, '.agents', 'history', 'AGENT-01.md'), 'utf8');
      assert.match(history, /escreveu com o painel travado/);
    } finally {
      clearInterval(keepFresh);
      await held.close();
      await rm(lockFile, { force: true });
    }

    // Once the lock frees up, the next write brings the panel back in sync.
    await service.activity({ agentId: 'AGENT-01', type: 'NOTE', description: 'painel liberado' });
    const memory = await service.store.readSharedMemory();
    assert.match(memory, /painel liberado/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
