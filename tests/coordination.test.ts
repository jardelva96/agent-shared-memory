import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { globToRegExp, patternCovers, patternsOverlap } from '../src/core/reservations.js';
import { createMcpMethods } from '../src/mcp/server.js';
import { runClaudeHook, runGitPreCommit, setupClaude } from '../src/cli/hooks.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function withProject(fn: (service: AgentMemoryService, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-coord-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Coordination');
    await service.register('A');
    await service.register('B');
    await fn(service, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hookInput(root: string, tool: string, file: string, session = 'sessaoB1'): string {
  return JSON.stringify({ session_id: session, cwd: root, tool_name: tool, tool_input: { file_path: path.join(root, file) } });
}

test('patterns: a folder covers its files, globs match by segment, and overlap is checked both ways', () => {
  assert.ok(patternCovers('src/auth', 'src/auth/login.ts'));
  assert.ok(!patternCovers('src/auth', 'src/authz.ts'));
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/a/b/c.test.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(patternsOverlap('src/**', 'src/a.ts'));
  assert.ok(patternsOverlap('src/a/**', 'src/a/*.ts'));
  assert.ok(!patternsOverlap('src/a/**', 'docs/**'));
});

test('a reservation is all or nothing, exclusive keeps others out, shared admits readers', async () => {
  await withProject(async service => {
    const first = await service.reserve('A', ['src/auth/'], { reason: 'login novo' });
    assert.equal(first.granted.length, 1);

    const refused = await service.reserve('B', ['docs/x.md', 'src/auth/token.ts']);
    assert.equal(refused.granted.length, 0, 'nothing granted, not even the free docs/x.md');
    assert.equal(refused.conflicts[0].holder.agentId, 'A');
    assert.equal((await service.reservations.active()).length, 1);

    await service.reserve('A', ['README.md'], { exclusive: false });
    assert.equal((await service.reserve('B', ['README.md'], { exclusive: false })).granted.length, 1, 'two readers');
    assert.equal((await service.reserve('B', ['README.md'])).conflicts.length, 1, 'but no writer');

    assert.equal(await service.release('A'), 2);
    assert.equal((await service.reserve('B', ['src/auth/token.ts'])).granted.length, 1);
  });
});

test('a reservation expires on its own, and leaving releases it', async () => {
  await withProject(async service => {
    const past = new Date(Date.now() - 3600_000);
    await service.reservations.reserve('A', ['src/a.ts'], { ttlSeconds: 60, now: past });
    assert.equal((await service.reservations.active()).length, 0);
    assert.equal((await service.reserve('B', ['src/a.ts'])).granted.length, 1);

    await service.unregister('B');
    assert.equal((await service.reservations.active()).length, 0);
  });
});

test('the pre-write hook refuses a file another agent reserved, and lets the holder through', async () => {
  await withProject(async (service, root) => {
    await service.reserve('A', ['src/auth/'], { reason: 'login novo' });
    const blocked = await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/auth/login.ts'), {});
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.stderr!, /reserved by A .*login novo/);

    const holder = await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/auth/login.ts'), { AGENT_MEMORY_AGENT: 'A' });
    assert.equal(holder.exitCode, 0);
    const other = await runClaudeHook('pre-write', hookInput(root, 'Write', 'docs/x.md'), {});
    assert.equal(other.exitCode, 0, 'free files are not affected');
  });
});

test('a write by one session warns the other before its next write to that file, once', async () => {
  await withProject(async (_service, root) => {
    const one = { AGENT_MEMORY_AGENT: 'ONE' };
    const two = { AGENT_MEMORY_AGENT: 'TWO' };
    // Both announce the file (pre-write), then ONE writes it (post-write).
    assert.equal((await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/texto.js'), one)).exitCode, 0);
    assert.equal((await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/texto.js'), two)).exitCode, 0);
    await runClaudeHook('post-write', hookInput(root, 'Edit', 'src/texto.js'), one);

    const stale = await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/texto.js'), two);
    assert.equal(stale.exitCode, 2, 'TWO is stopped before writing over ONE');
    assert.match(stale.stderr!, /ONE just changed src\/texto\.js.*Read src\/texto\.js again/s);
    assert.equal((await runClaudeHook('pre-write', hookInput(root, 'Edit', 'src/texto.js'), two)).exitCode, 0, 'after reading, it goes through');
  });
});

test('session start hands the briefing to Claude Code, and nothing happens outside a project', async () => {
  await withProject(async (service, root) => {
    await service.remember('Testes precisam do Postgres na porta 5477', 'A');
    const out = await runClaudeHook('session-start', JSON.stringify({ session_id: 'abc', cwd: root }), {});
    const parsed = JSON.parse(out.stdout!);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Postgres na porta 5477/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /You are CC-ABC/);
  });
  const empty = await mkdtemp(path.join(os.tmpdir(), 'asm-none-'));
  try {
    assert.deepEqual(await runClaudeHook('pre-write', hookInput(empty, 'Write', 'a.ts'), {}), { exitCode: 0 });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('setup claude writes the hooks and the MCP server, keeps other hooks, and removes only its own', async () => {
  await withProject(async (_service, root) => {
    await mkdir(path.join(root, '.claude'), { recursive: true });
    const mine = { type: 'command', command: 'echo outro' };
    await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } }));

    await setupClaude(root, { command: 'agent-memory' });
    await setupClaude(root, { command: 'agent-memory' }); // twice is the same as once
    const settings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [mine]);
    assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, 'agent-memory hook claude pre-write');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'agent-memory hook claude session-start');
    const mcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers['agent-memory'], { command: 'agent-memory', args: ['mcp'] });

    await setupClaude(root, { command: 'agent-memory', remove: true });
    const after = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(after.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] });
  });
});

test('the git pre-commit guard refuses staged files another agent reserved', async () => {
  await withProject(async (service, root) => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
    await service.reserve('A', ['src/a.ts']);

    const refused = await runGitPreCommit(root, { AGENT_MEMORY_AGENT: 'B' });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr!, /src\/a\.ts: reserved by A/);
    assert.equal((await runGitPreCommit(root, { AGENT_MEMORY_AGENT: 'A' })).exitCode, 0);
  });
});

test('the queue hands out the most urgent ready task first, and a review inherits its priority', async () => {
  await withProject(async service => {
    await service.createTask({ title: 'normal', createdBy: 'A' });
    const urgent = await service.createTask({ title: 'urgente', createdBy: 'A', priority: 0, reviewOpen: true });
    assert.deepEqual((await service.readyTasks('B')).map(t => t.title), ['urgente', 'normal']);
    assert.equal((await service.claimTask('B'))!.id, urgent.id);
    assert.equal((await service.tasks.read(urgent.reviewTaskId!)).priority, 0);
    await assert.rejects(service.createTask({ title: 'x', createdBy: 'A', priority: 7 }), /priority must be/);
  });
});

test('facts reach the briefing and the shared memory, once each', async () => {
  await withProject(async service => {
    await service.remember('Nunca commitar direto na prod', 'A');
    await service.remember('nunca commitar direto na prod', 'B');
    assert.equal((await service.facts.list()).length, 1);
    await service.reserve('A', ['src/']);
    const memory = await service.store.readSharedMemory();
    assert.match(memory, /## PROJECT FACTS\n\n- Nunca commitar direto na prod/);
    assert.match(memory, /## RESERVED FILES\n\n- src\/\*\* \| A \| exclusive/);
    assert.match(await service.prime('B'), /Reserved files:\n- src\/\*\*: A/);
  });
});

test('over MCP, an edit by symbol respects a reservation and tells the others when it lands', async () => {
  await withProject(async (service, root) => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'm.ts'), 'export function a() {\n  return 1;\n}\n');
    const methods = createMcpMethods(service);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await methods.get('tools/call')!({ name, arguments: args })) as ToolResult;

    await service.activity({ agentId: 'B', type: 'INTENT', description: 'olhando', pointer: { file: 'src/m.ts' } });
    await call('memory_reserve', { agent: 'B', paths: ['src/m.ts'] });
    const refused = await call('memory_replace_symbol', { agent: 'A', pointer: 'src/m.ts::a', code: 'export function a() {\n  return 2;\n}' });
    assert.match(refused.content[0].text, /Not changed: src\/m\.ts is reserved by B/);

    await call('memory_release', { agent: 'B' });
    const done = await call('memory_replace_symbol', { agent: 'A', pointer: 'src/m.ts::a', code: 'export function a() {\n  return 2;\n}' });
    assert.match(done.content[0].text, /Replaced at src\/m\.ts lines 1-3/);
    assert.match(await readFile(path.join(root, 'src', 'm.ts'), 'utf8'), /return 2;/);
    const inbox = await service.readInbox('B', { markRead: false });
    assert.ok(inbox.messages.some(m => /A just changed src\/m\.ts/.test(m.body)), 'B hears that its copy is stale');

    const outline = await call('memory_symbols', { file: 'src/m.ts' });
    assert.match(outline.content[0].text, /1-3 function a/);
  });
});

test('a task shows its whole story: claim, rejection, the redo and the verdicts', async () => {
  await withProject(async service => {
    const work = await service.createTask({ title: 'formatar moeda', createdBy: 'A', reviewOpen: true });
    await service.claimTask('A');
    await service.finishTask(work.id, 'DONE', 'feito', 'A');
    const review = await service.claimTask('B');
    await service.finishTask(review!.id, 'FAILED', 'esqueceu o negativo', 'B');

    const { task, reviews, events } = await service.taskHistory(work.id);
    assert.equal(task.reviewRounds, 1);
    assert.equal(reviews.length, 2, 'the rejecting review and the next round');
    assert.match(reviews[0].result!, /esqueceu o negativo/);
    const said = events.map(e => e.description).join('\n');
    assert.match(said, /claimed .*formatar moeda/);
    assert.match(said, /review rejected/i);
  });
});
