import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { startHub } from '../src/remote/hub.js';
import { remoteService } from '../src/remote/client.js';
import { runClaudeHook } from '../src/cli/hooks.js';
import { createMcpMethods } from '../src/mcp/server.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
}

/** A hub machine and two other machines, each with its own checkout and no .agents/ of its own. */
async function withMachines(
  fn: (ctx: { url: string; token: string; hubService: AgentMemoryService; laptopA: string; laptopB: string }) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'asm-remote-'));
  const hubRoot = path.join(base, 'hub');
  const laptopA = path.join(base, 'a');
  const laptopB = path.join(base, 'b');
  for (const dir of [hubRoot, laptopA, laptopB]) await mkdir(path.join(dir, 'src'), { recursive: true });
  for (const dir of [laptopA, laptopB]) await writeFile(path.join(dir, 'src', 'm.ts'), 'export function a() {\n  return 1;\n}\n');
  const hubService = new AgentMemoryService(hubRoot);
  await hubService.init('Remote');
  const hub = await startHub(hubService, { port: 0, token: 'segredo-de-teste' });
  try {
    await fn({ url: hub.url, token: hub.token, hubService, laptopA, laptopB });
  } finally {
    await new Promise(resolve => hub.server.close(resolve));
    await rm(base, { recursive: true, force: true });
  }
}

test('the hub answers only with its token, and only the coordination operations', async () => {
  await withMachines(async ({ url, token }) => {
    const noToken = await fetch(`${url}/rpc`, { method: 'POST', body: JSON.stringify({ method: 'states', args: [] }) });
    assert.equal(noToken.status, 401);

    const post = (method: string) =>
      fetch(`${url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args: [] }) });
    for (const forbidden of ['init', 'compact', 'updateConfig', 'store.deleteState', 'constructor']) {
      assert.equal((await post(forbidden)).status, 403, forbidden);
    }
    assert.equal((await post('states')).status, 200);
  });
});

test('a reservation taken on one machine blocks a write on another, at once', async () => {
  await withMachines(async ({ url, token, laptopA, laptopB }) => {
    const a = remoteService(laptopA, { url, token });
    await a.register('A');
    const granted = await a.reserve('A', ['src/m.ts'], { reason: 'refatorando' });
    assert.equal(granted.granted.length, 1);

    const env = { AGENT_MEMORY_REMOTE: url, AGENT_MEMORY_TOKEN: token, AGENT_MEMORY_AGENT: 'B' };
    const input = JSON.stringify({ session_id: 'b', cwd: laptopB, tool_name: 'Edit', tool_input: { file_path: path.join(laptopB, 'src', 'm.ts') } });
    const blocked = await runClaudeHook('pre-write', input, env);
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.stderr!, /reserved by A .*refatorando/);

    await a.release('A');
    assert.equal((await runClaudeHook('pre-write', input, env)).exitCode, 0);
  });
});

test('over MCP on another machine, the edit is local and the coordination is shared', async () => {
  await withMachines(async ({ url, token, hubService, laptopA, laptopB }) => {
    const a = remoteService(laptopA, { url, token });
    const b = remoteService(laptopB, { url, token });
    await a.register('A');
    await b.register('B');
    await a.activity({ agentId: 'A', type: 'INTENT', description: 'mexendo em a()', pointer: { file: 'src/m.ts' } });

    const methods = createMcpMethods(b);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;

    const done = await call('memory_replace_symbol', { agent: 'B', pointer: 'src/m.ts::a', code: 'export function a() {\n  return 2;\n}' });
    assert.match(done.content[0].text, /Replaced at src\/m\.ts/);
    assert.match(await readFile(path.join(laptopB, 'src', 'm.ts'), 'utf8'), /return 2;/, 'B edited its own checkout');
    assert.match(await readFile(path.join(laptopA, 'src', 'm.ts'), 'utf8'), /return 1;/, 'A\'s checkout is untouched');

    // ...and A, on another machine, hears that its copy is stale.
    const inbox = await a.readInbox('A', { markRead: false });
    assert.ok(inbox.messages.some(m => /B just changed src\/m\.ts/.test(m.body)));
    assert.equal((await hubService.store.listStates()).length, 2, 'both agents live in the hub');

    const status = await call('memory_status', { agent: 'B' });
    assert.match(status.content[0].text, /A/);
  });
});
