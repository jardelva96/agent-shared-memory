/** The memory of another machine, used as if it were local. */
import { AgentMemoryService } from '../core/service.js';

export interface RemoteSettings {
  url: string;
  token: string;
}

/** AGENT_MEMORY_REMOTE and AGENT_MEMORY_TOKEN, when both are set. */
export function remoteFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteSettings | undefined {
  const url = env.AGENT_MEMORY_REMOTE?.trim();
  const token = env.AGENT_MEMORY_TOKEN?.trim();
  return url && token ? { url, token } : undefined;
}

export function isRemote(service: AgentMemoryService): boolean {
  return (service as unknown as { remote?: boolean }).remote === true;
}

export function remoteService(root: string, settings: RemoteSettings): AgentMemoryService {
  const base = settings.url.replace(/\/+$/, '');

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new Error(`The shared memory at ${base} did not answer (${error instanceof Error ? error.message : String(error)}).`);
    }
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: unknown; error?: string };
    if (!body.ok) throw new Error(body.error ?? `The shared memory at ${base} answered ${response.status}.`);
    return body.value === null ? undefined : body.value;
  };

  // `service.tasks.list(...)` becomes the call "tasks.list"; `then` stays undefined so the proxy is
  // not mistaken for a promise.
  const member = (path: string): unknown =>
    new Proxy(function remote() {}, {
      get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? member(`${path}.${prop}`) : undefined),
      apply: (_target, _this, args: unknown[]) => call(path, args)
    });

  const local = { root, remote: true, url: base };
  return new Proxy(local, {
    get: (target, prop) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      return member(prop);
    }
  }) as unknown as AgentMemoryService;
}
