/** HTTP hub that shares one memory between machines. */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentMemoryService } from '../core/service.js';

/** What a remote agent may call. */
export const REMOTE_METHODS = new Set([
  'config',
  'states',
  'prime',
  'readyTasks',
  'taskHistory',
  'releaseTask',
  'register',
  'reset',
  'unregister',
  'forgetIdleSessions',
  'heartbeat',
  'activity',
  'sendMessage',
  'readInbox',
  'createTask',
  'claimTask',
  'finishTask',
  'renewTask',
  'reserve',
  'release',
  'remember',
  'forget',
  'createSchedule',
  'runDueSchedules',
  'store.stateExists',
  'store.listStates',
  'store.readSharedMemory',
  'store.recentActivities',
  'messages.unreadCount',
  'tasks.list',
  'tasks.read',
  'reservations.active',
  'reservations.holders',
  'facts.list',
  'schedules.list',
  'schedules.remove',
  'notePlaces',
  'noteShellWrites',
  'guardContext',
  'noteGuard'
]);

const MAX_BODY = 1_000_000;

export interface HubOptions {
  port?: number;
  /** 127.0.0.1 by default; 0.0.0.0 to accept other machines. */
  host?: string;
  /** Required from every caller. */
  token?: string;
}

export interface Hub {
  server: http.Server;
  url: string;
  token: string;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function startHub(service: AgentMemoryService, options: HubOptions = {}): Promise<Hub> {
  const token = options.token || newToken();
  const expected = Buffer.from(`Bearer ${token}`);
  const host = options.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      reply(401, { ok: false, error: 'Missing or wrong token.' });
      return;
    }
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      const config = await service.config().catch(() => undefined);
      reply(200, { ok: true, project: config?.projectName ?? null });
      return;
    }
    if (req.method !== 'POST' || url !== '/rpc') {
      reply(404, { ok: false, error: 'Use POST /rpc.' });
      return;
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reply(413, { ok: false, error: 'Request too large.' });
        return;
      }
    }
    let call: { method?: unknown; args?: unknown };
    try {
      call = JSON.parse(raw);
    } catch {
      reply(400, { ok: false, error: 'Body is not JSON.' });
      return;
    }
    const method = typeof call.method === 'string' ? call.method : '';
    if (!REMOTE_METHODS.has(method)) {
      reply(403, { ok: false, error: `Not available remotely: ${method || '(none)'}. Run it on the machine that hosts the memory.` });
      return;
    }
    // JSON has no undefined: an omitted optional argument arrives as null.
    const args = (Array.isArray(call.args) ? call.args : []).map(a => (a === null ? undefined : a));
    try {
      const [owner, name] = method.includes('.') ? [(service as any)[method.split('.')[0]], method.split('.')[1]] : [service, method];
      const value = await owner[name](...args);
      reply(200, { ok: true, value: value === undefined ? null : value });
    } catch (error) {
      reply(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port ?? 4318;
  return { server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, token };
}
