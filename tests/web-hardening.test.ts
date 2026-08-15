import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { startDashboard } from '../src/web/server.js';

async function withDashboard(
  fn: (port: number, service: AgentMemoryService) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-hard-'));
  const service = new AgentMemoryService(root);
  await service.init('Hardening', { autoCompactAfterEvents: 0 });
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

function request(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/snapshot', headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('a foreign Host header is refused, so a web page cannot read the port', async () => {
  await withDashboard(async port => {
    // DNS rebinding: the browser connects to 127.0.0.1 but carries the attacker's name.
    assert.equal(await request(port, { host: 'evil.example.com' }), 403);
    assert.equal(await request(port, { host: 'agent-memory.attacker.io:4317' }), 403);
  });
});

test('the names a person actually types are accepted', async () => {
  await withDashboard(async port => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1']) {
      assert.equal(await request(port, { host }), 200, host);
    }
  });
});

test('a second SSE client does not steal the update the first is waiting for', async () => {
  await withDashboard(async (port, service) => {
    await service.register('AGENT-01');

    const frames: unknown[][] = [[], []];
    const sockets: http.ClientRequest[] = [];
    const readers = [0, 1].map(
      index =>
        new Promise<void>(resolve => {
          const req = http.get({ host: '127.0.0.1', port, path: '/events' }, res => {
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
              buffer += chunk;
              let cut: number;
              while ((cut = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                for (const line of block.split('\n')) {
                  if (line.startsWith('data: ')) frames[index].push(JSON.parse(line.slice(6)));
                }
              }
            });
            resolve();
          });
          sockets.push(req);
        })
    );
    await Promise.all(readers);
    await new Promise(r => setTimeout(r, 200));

    const before = frames.map(f => f.length);
    await service.activity({ agentId: 'AGENT-01', type: 'NOTE', description: 'mudou' });
    await new Promise(r => setTimeout(r, 400));

    // Both connected clients must see the change; marking it delivered for one would
    // leave the other showing stale state until something else happened to change.
    assert.ok(frames[0].length > before[0], 'first client received the change');
    assert.ok(frames[1].length > before[1], 'second client received it too');
    for (const socket of sockets) socket.destroy();
  });
});
