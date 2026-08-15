import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { detectOverlapPairs } from '../src/core/conflicts.js';
import { parsePointer } from '../src/core/pointer.js';
import { buildSnapshot } from '../src/web/snapshot.js';
import { startDashboard } from '../src/web/server.js';
import { AgentState, ProjectConfig } from '../src/models/types.js';

const CONFIG: ProjectConfig = {
  version: 1,
  staleAfterSeconds: 60,
  recentHistoryLimit: 20,
  projectName: 'Test'
};

function stateAt(id: string, pointer: string, ageSeconds = 0): AgentState {
  const iso = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    id,
    sessionId: `session-${id}`,
    status: 'WORKING',
    current: { type: 'INTENT', description: `${id} working`, pointer: parsePointer(pointer) },
    startedAt: iso,
    updatedAt: iso,
    lastHeartbeatAt: iso
  };
}

test('overlap pairs are found across the whole panel', () => {
  const pairs = detectOverlapPairs(
    [
      stateAt('AGENT-01', 'src/Orders.cs::OrderService.CancelAsync(Guid id)'),
      stateAt('AGENT-02', 'src/Orders.cs::OrderService.CancelAsync(Guid id)'),
      stateAt('AGENT-03', 'src/Payments.cs::RefundService.Create()')
    ],
    CONFIG
  );
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].agents, ['AGENT-01', 'AGENT-02']);
  assert.equal(pairs[0].exact, true);
});

test('a stale agent is not reported as an active overlap', () => {
  const pairs = detectOverlapPairs(
    [
      stateAt('AGENT-01', 'src/Orders.cs::OrderService.CancelAsync(Guid id)'),
      stateAt('AGENT-02', 'src/Orders.cs::OrderService.CancelAsync(Guid id)', 600)
    ],
    CONFIG
  );
  assert.deepEqual(pairs, [], 'an agent past staleAfterSeconds counts as OFFLINE');
});

test('snapshot annotates each agent with who it overlaps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-snap-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Snapshot Project');
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    await service.register('AGENT-03');

    const pointer = parsePointer('src/Orders.cs::OrderService.CancelAsync(Guid id)');
    await service.activity({ agentId: 'AGENT-01', type: 'INTENT', description: 'cancelamento', pointer });
    await service.activity({ agentId: 'AGENT-02', type: 'INTENT', description: 'cancelamento', pointer });
    await service.activity({
      agentId: 'AGENT-03',
      type: 'INTENT',
      description: 'reembolso',
      pointer: parsePointer('src/Payments.cs::RefundService.Create()')
    });

    const snapshot = await buildSnapshot(service);
    assert.equal(snapshot.project, 'Snapshot Project');
    assert.equal(snapshot.overlaps.length, 1);

    const byId = new Map(snapshot.agents.map(a => [a.id, a]));
    assert.deepEqual(byId.get('AGENT-01')!.overlapsWith, ['AGENT-02']);
    assert.deepEqual(byId.get('AGENT-02')!.overlapsWith, ['AGENT-01']);
    assert.deepEqual(byId.get('AGENT-03')!.overlapsWith, []);
    assert.equal(byId.get('AGENT-01')!.status, 'WORKING');
    assert.ok(snapshot.events.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface Sse {
  frames: unknown[];
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

function openSse(port: number): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/events' }, response => {
      const frames: unknown[] = [];
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
          }
        }
      });
      resolve({
        frames,
        async waitFor(count, timeoutMs = 4000) {
          const deadline = Date.now() + timeoutMs;
          while (frames.length < count) {
            if (Date.now() > deadline) {
              throw new Error(`Timed out waiting for ${count} frame(s); got ${frames.length}`);
            }
            await new Promise(r => setTimeout(r, 20));
          }
        },
        close: () => request.destroy()
      });
    });
    request.on('error', reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (body += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            type: String(response.headers['content-type'] ?? '')
          })
        );
      })
      .on('error', reject);
  });
}

async function withDashboard(fn: (port: number, service: AgentMemoryService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-web-'));
  const service = new AgentMemoryService(root);
  await service.init('Web Project');
  const server = await startDashboard(service, 0, { pollIntervalMs: 40 });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(port, service);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test('dashboard serves the shell, the snapshot and the legacy endpoints', async () => {
  await withDashboard(async (port, service) => {
    await service.register('AGENT-01', 'Backend', 'AUTH-184');

    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /new EventSource\('\/events'\)/);
    assert.doesNotMatch(page.body, /location\.reload/, 'the page must not reload itself any more');

    const snapshot = await get(port, '/api/snapshot');
    const parsed = JSON.parse(snapshot.body) as { project: string; agents: Array<{ id: string }> };
    assert.equal(parsed.project, 'Web Project');
    assert.equal(parsed.agents[0].id, 'AGENT-01');

    const status = await get(port, '/api/status');
    assert.match(status.body, /effectiveStatus/, 'legacy shape is preserved');

    const memory = await get(port, '/api/memory');
    assert.match(memory.body, /SHARED AGENT MEMORY/);

    const missing = await get(port, '/nope');
    assert.equal(missing.status, 404);
  });
});

test('SSE sends the current state on connect and pushes only on change', async () => {
  await withDashboard(async (port, service) => {
    await service.register('AGENT-01');

    const sse = await openSse(port);
    try {
      await sse.waitFor(1);
      const first = sse.frames[0] as { agents: Array<{ id: string; description: string }> };
      assert.equal(first.agents.length, 1);
      assert.equal(first.agents[0].id, 'AGENT-01');

      // Idle project: no further frames should arrive.
      await new Promise(r => setTimeout(r, 300));
      assert.equal(sse.frames.length, 1, 'an unchanged project must not produce traffic');

      await service.activity({
        agentId: 'AGENT-01',
        type: 'INTENT',
        description: 'mexendo no cancelamento',
        pointer: parsePointer('src/Orders.cs::OrderService.CancelAsync(Guid id)')
      });

      await sse.waitFor(2);
      const second = sse.frames[1] as { agents: Array<{ description: string; pointer: string }> };
      assert.equal(second.agents[0].description, 'mexendo no cancelamento');
      assert.match(second.agents[0].pointer, /CancelAsync/);
    } finally {
      sse.close();
    }
  });
});

test('SSE reports an overlap as soon as the second agent claims the pointer', async () => {
  await withDashboard(async (port, service) => {
    await service.register('AGENT-01');
    await service.register('AGENT-02');
    const pointer = parsePointer('src/Orders.cs::OrderService.CancelAsync(Guid id)');
    await service.activity({ agentId: 'AGENT-01', type: 'INTENT', description: 'cancelamento', pointer });

    const sse = await openSse(port);
    try {
      await sse.waitFor(1);
      assert.deepEqual((sse.frames[0] as { overlaps: unknown[] }).overlaps, []);

      await service.activity({ agentId: 'AGENT-02', type: 'INTENT', description: 'também cancelamento', pointer });

      await sse.waitFor(2);
      const overlaps = (sse.frames[1] as { overlaps: Array<{ agents: string[]; exact: boolean }> }).overlaps;
      assert.equal(overlaps.length, 1);
      assert.deepEqual(overlaps[0].agents, ['AGENT-01', 'AGENT-02']);
      assert.equal(overlaps[0].exact, true);
    } finally {
      sse.close();
    }
  });
});
