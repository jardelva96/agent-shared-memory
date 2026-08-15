import http from 'node:http';
import { effectiveStatus } from '../core/render.js';
import { AgentMemoryService } from '../core/service.js';
import { renderDashboardPage } from './page.js';
import { buildSnapshot, DashboardSnapshot } from './snapshot.js';

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 25_000;

export interface DashboardOptions {
  port?: number;
  pollIntervalMs?: number;
}

export async function startDashboard(
  service: AgentMemoryService,
  port = 4317,
  options: DashboardOptions = {}
): Promise<http.Server> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const clients = new Set<http.ServerResponse>();
  let poller: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastSignature = '';

  /**
   * Polls the store and pushes only when something actually changed, so an idle
   * project produces no traffic and the page never re-renders for nothing.
   */
  async function pushIfChanged(force = false): Promise<void> {
    if (clients.size === 0) return;
    let snapshot: DashboardSnapshot;
    try {
      snapshot = await buildSnapshot(service);
    } catch {
      return; // A transient read (mid-write, missing .agents/) must not kill the stream.
    }
    const signature = signatureOf(snapshot);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  function startPolling(): void {
    if (poller) return;
    poller = setInterval(() => void pushIfChanged(), pollIntervalMs);
    heartbeat = setInterval(() => {
      for (const client of clients) client.write(': ping\n\n');
    }, HEARTBEAT_MS);
  }

  function stopPolling(): void {
    if (poller) clearInterval(poller);
    if (heartbeat) clearInterval(heartbeat);
    poller = undefined;
    heartbeat = undefined;
    lastSignature = '';
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        clients.add(res);
        startPolling();

        // The new client needs the current state, not just the next change. Recording the
        // signature here keeps the next poll from pushing the same snapshot a second time.
        const snapshot = await buildSnapshot(service);
        lastSignature = signatureOf(snapshot);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

        req.on('close', () => {
          clients.delete(res);
          if (clients.size === 0) stopPolling();
        });
        return;
      }

      if (url === '/api/snapshot') {
        json(res, await buildSnapshot(service));
        return;
      }

      if (url === '/api/status') {
        // Kept in the original shape: documented and possibly scripted against.
        const config = await service.config();
        const states = await service.states();
        json(res, {
          project: config.projectName,
          generatedAt: new Date().toISOString(),
          agents: states.map(s => ({ ...s, effectiveStatus: effectiveStatus(s, config) }))
        });
        return;
      }

      if (url === '/api/memory') {
        let memory: string;
        try {
          memory = await service.store.readSharedMemory();
        } catch {
          memory = `No .agents/ found in ${service.root}. Run "agent-memory init" first.`;
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(memory);
        return;
      }

      if (url === '/') {
        const config = await service.config();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderDashboardPage(config.projectName));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  server.on('close', () => {
    stopPolling();
    for (const client of clients) client.end();
    clients.clear();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

/** Everything a viewer cares about, minus generatedAt — which changes on every build. */
function signatureOf(snapshot: DashboardSnapshot): string {
  return JSON.stringify([snapshot.agents, snapshot.overlaps, snapshot.events]);
}

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload, null, 2));
}
