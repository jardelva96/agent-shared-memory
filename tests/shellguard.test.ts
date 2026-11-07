import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { classifyGit, isReadOnly, parseShell, summarize } from '../src/core/shellguard.js';
import { runClaudeHook, setupClaude } from '../src/cli/hooks.js';

test('commands: cd and -C are followed, quotes and heredocs are not commands, asm-ok is read', () => {
  const root = path.resolve(os.tmpdir(), 'ws');
  const a = parseShell(`cd "${path.join(root, 'app')}" && git status && git checkout -b fix/x origin/prod`, root);
  assert.deepEqual(a.dirs, [root, path.join(root, 'app')]);
  assert.equal(a.git.length, 2);
  assert.equal(a.git[1].dir, path.join(root, 'app'));
  assert.equal(a.git[1].risk, 'branch');
  assert.equal(a.git[0].risk, undefined);

  const c = parseShell('git -C app switch main', root);
  assert.equal(c.git[0].dir, path.join(root, 'app'));
  assert.equal(c.git[0].risk, 'branch');

  const ps = parseShell(`Set-Location -Path "${path.join(root, 'web')}"; git stash`, root);
  assert.equal(ps.git[0].dir, path.join(root, 'web'));
  assert.equal(ps.git[0].risk, 'branch');

  const text = parseShell(`git commit -m "fix; then git checkout main" && cat >> notes.md <<'EOF'\ngit reset --hard\nEOF\necho ok`, root);
  assert.deepEqual(text.git.map(g => g.subcommand), ['commit'], 'quoted text and heredoc lines are not commands');

  const timed = parseShell('timeout 300 git pull', root);
  assert.equal(timed.git[0].risk, 'branch');

  assert.equal(parseShell('git checkout main # asm-ok: são minhas', root).acknowledged, 'são minhas');
  assert.equal(parseShell('git checkout main', root).acknowledged, undefined);
});

test('the summary other sessions see names the programs and never the arguments', () => {
  const s = summarize(`cd "C:/x" && git -c http.extraheader="AUTHORIZATION: bearer glpat-SEGREDO" push https://u:SENHA@gitlab.com/r.git && TOKEN=abc curl -H "x: y" https://api`);
  assert.equal(s, 'cd && git push && curl');
  assert.doesNotMatch(s, /SEGREDO|SENHA|abc|glpat/);
});

test('git commands: what moves a checkout, what sweeps everything into a commit, what is harmless', () => {
  const cases: Array<[string, string[], string | undefined]> = [
    ['checkout', ['-b', 'x'], 'branch'],
    ['checkout', ['--', 'a.cs'], 'branch'],
    ['checkout', [], undefined],
    ['switch', ['main'], 'branch'],
    ['stash', [], 'branch'],
    ['stash', ['pop'], 'branch'],
    ['stash', ['list'], undefined],
    ['reset', ['--hard'], 'branch'],
    ['restore', ['a.cs'], 'branch'],
    ['pull', [], 'branch'],
    ['merge', ['origin/prod'], 'branch'],
    ['rebase', ['main'], 'branch'],
    ['clean', ['-fd'], 'branch'],
    ['clean', ['-nd'], undefined],
    ['commit', ['-am', 'x'], 'sweep'],
    ['commit', ['-m', 'x'], undefined],
    ['commit', ['--amend'], undefined],
    ['add', ['-A'], 'sweep'],
    ['add', ['.'], 'sweep'],
    ['add', ['src/a.cs'], undefined],
    ['status', [], undefined],
    ['log', ['--oneline'], undefined],
    ['push', ['-u', 'origin', 'x'], undefined],
    ['checkout', ['--help'], undefined]
  ];
  for (const [sub, args, risk] of cases) assert.equal(classifyGit(sub, args), risk, `git ${sub} ${args.join(' ')}`);
});

test('read-only commands skip the after-command scan; anything that may write does not', () => {
  for (const c of ['ls -la', 'cd x && git status && git log -3', 'grep -n foo src/*.ts | head', 'git diff --stat 2>/dev/null', 'git stash list', 'sed -n 1,20p a.ts']) {
    assert.equal(isReadOnly(c), true, c);
  }
  for (const c of ['echo x > a.txt', 'sed -i s/a/b/ a.ts', 'npm test', 'git stash', 'git checkout main', 'cat >> a <<EOF\nx\nEOF', 'X=1 node a.js', 'curl -o f https://x']) {
    assert.equal(isReadOnly(c), false, c);
  }
});

// ----- The hooks against a real git checkout -----

const GIT = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

async function withWorkspace(fn: (root: string, app: string, service: AgentMemoryService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-guard-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('Guard');
    const app = path.join(root, 'app');
    await mkdir(path.join(app, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'prod'], { cwd: app });
    await writeFile(path.join(app, 'src', 'senha.cs'), 'class Senha {}\n');
    await writeFile(path.join(app, 'src', 'outro.cs'), 'class Outro {}\n');
    execFileSync('git', [...GIT, 'add', '-A'], { cwd: app });
    execFileSync('git', [...GIT, 'commit', '-q', '-m', 'start'], { cwd: app });
    await fn(root, app, service);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const shell = (root: string, command: string) =>
  JSON.stringify({ session_id: 'x', cwd: root, tool_name: 'Bash', tool_input: { command } });
const as = (id: string) => ({ AGENT_MEMORY_AGENT: id });

/** A session runs a shell command that writes a file, with both hooks around it, as Claude Code would. */
async function shellWrite(root: string, id: string, file: string, content: string): Promise<void> {
  const command = `cd "${path.dirname(file)}" && printf x > ${path.basename(file)}`;
  assert.equal((await runClaudeHook('pre-shell', shell(root, command), as(id))).exitCode, 0);
  await writeFile(file, content);
  await runClaudeHook('post-shell', shell(root, command), as(id));
}

test('the incident of 2026-11-07: a branch switch under another session is refused, and says why', async () => {
  await withWorkspace(async (root, app) => {
    // ONE works in the checkout through the shell and leaves a file changed.
    await shellWrite(root, 'ONE', path.join(app, 'src', 'senha.cs'), 'class Senha { int nova; }\n');

    // TWO, in the same folder, wants a branch of its own.
    const out = await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git checkout -q -b fix/outra prod`), as('TWO'));
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr!, /would change the checkout app/);
    assert.match(out.stderr!, /src\/senha\.cs/);
    assert.match(out.stderr!, /ONE \(shell, just now: cd && printf\)/);
    assert.match(out.stderr!, /# asm-ok/);

    // ONE switching its own checkout is not in its way.
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git checkout -q -b fix/minha`), as('ONE'))).exitCode, 0);
  });
});

test('asm-ok lets the command through and leaves it on record for guard-log', async () => {
  await withWorkspace(async (root, app, service) => {
    await shellWrite(root, 'ONE', path.join(app, 'src', 'senha.cs'), 'mudou\n');
    const out = await runClaudeHook('pre-shell', shell(root, `git -C "${app}" stash # asm-ok: combinado com a ONE`), as('TWO'));
    assert.equal(out.exitCode, 0);
    const notes = (await service.store.recentActivities(50)).map(e => e.description);
    assert.ok(notes.some(d => d.startsWith('guard: let through by asm-ok (combinado com a ONE)')), notes.join('\n'));
    assert.ok(notes.some(d => d.startsWith('git: ')));
  });
});

test('changes made with the edit tools are the session own too', async () => {
  await withWorkspace(async (root, app) => {
    const file = path.join(app, 'src', 'outro.cs');
    const edit = JSON.stringify({ session_id: 'x', cwd: root, tool_name: 'Edit', tool_input: { file_path: file } });
    await runClaudeHook('pre-shell', shell(root, `cd "${app}" && ls`), as('ONE'));
    await runClaudeHook('pre-shell', shell(root, `cd "${app}" && ls`), as('TWO'));
    await runClaudeHook('pre-write', edit, as('TWO'));
    await writeFile(file, 'class Outro { }\n');
    await runClaudeHook('post-write', edit, as('TWO'));
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git switch -q -c fix/dois`), as('TWO'))).exitCode, 0);
  });
});

test('nobody else in the checkout: recent changes are let through, and that is noted', async () => {
  await withWorkspace(async (root, app, service) => {
    await writeFile(path.join(app, 'src', 'senha.cs'), 'mexido por fora\n');
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git checkout -q -b fix/x`), as('TWO'))).exitCode, 0);
    const notes = (await service.store.recentActivities(50)).map(e => e.description);
    assert.ok(notes.some(d => d.includes('recent change(s) nobody here claimed')), notes.join('\n'));
  });
});

test('another session that just moved the branch blocks a second move, even with a clean tree', async () => {
  await withWorkspace(async (root, app) => {
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git checkout -q -b fix/um`), as('ONE'))).exitCode, 0);
    execFileSync('git', ['checkout', '-q', '-b', 'fix/um'], { cwd: app });
    const out = await runClaudeHook('pre-shell', shell(root, `git -C "${app}" switch prod`), as('TWO'));
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr!, /ONE ran `.*git checkout -q -b fix\/um`/);
  });
});

test('a session that ended blocks nobody', async () => {
  await withWorkspace(async (root, app) => {
    await shellWrite(root, 'ONE', path.join(app, 'src', 'senha.cs'), 'mudou\n');
    await runClaudeHook('session-end', JSON.stringify({ session_id: 'x', cwd: root }), as('ONE'));
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git stash`), as('TWO'))).exitCode, 0);
  });
});

test('a session that was unregistered blocks nobody, though its events stay in the journal', async () => {
  await withWorkspace(async (root, app, service) => {
    const file = path.join(app, 'src', 'senha.cs');
    const edit = JSON.stringify({ session_id: 'x', cwd: root, tool_name: 'Edit', tool_input: { file_path: file } });
    await runClaudeHook('pre-write', edit, as('ONE'));
    await writeFile(file, 'mudou\n');
    await runClaudeHook('post-write', edit, as('ONE'));
    await service.unregister('ONE');
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git stash`), as('TWO'))).exitCode, 0);
  });
});

test('git add -A refuses to sweep another session new file into a commit; naming files is fine', async () => {
  await withWorkspace(async (root, app) => {
    await shellWrite(root, 'ONE', path.join(app, 'src', 'novo-da-um.cs'), 'class Novo {}\n');
    const sweep = await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git add -A && git commit -q -m x`), as('TWO'));
    assert.equal(sweep.exitCode, 2);
    assert.match(sweep.stderr!, /src\/novo-da-um\.cs/);
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git add src/outro.cs`), as('TWO'))).exitCode, 0);
  });
});

test('guardMinutes 0 turns the guard off', async () => {
  await withWorkspace(async (root, app, service) => {
    await service.updateConfig({ guardMinutes: 0 });
    await shellWrite(root, 'ONE', path.join(app, 'src', 'senha.cs'), 'mudou\n');
    assert.equal((await runClaudeHook('pre-shell', shell(root, `cd "${app}" && git checkout -q -b y`), as('TWO'))).exitCode, 0);
  });
});

test('the briefing can carry the project own rules', async () => {
  await withWorkspace(async (_root, _app, service) => {
    await service.updateConfig({ primeRules: ['Antes de trocar de branch, veja quem mais está na pasta.'] });
    const text = await service.prime('ONE');
    assert.match(text, /- Antes de trocar de branch, veja quem mais está na pasta\./);
    assert.doesNotMatch(text, /memory_replace_symbol/);
  });
});

test('setup claude --hooks-only writes the shell hooks and no MCP server', async () => {
  await withWorkspace(async root => {
    await setupClaude(root, { command: 'agent-memory', hooksOnly: true });
    const settings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const commands = (event: string) => settings.hooks[event].map((g: any) => `${g.matcher} -> ${g.hooks[0].command}`);
    assert.deepEqual(commands('PreToolUse'), [
      'Write|Edit|MultiEdit|NotebookEdit -> agent-memory hook claude pre-write',
      'Bash|PowerShell -> agent-memory hook claude pre-shell'
    ]);
    assert.deepEqual(commands('PostToolUse'), [
      'Write|Edit|MultiEdit|NotebookEdit -> agent-memory hook claude post-write',
      'Bash|PowerShell -> agent-memory hook claude post-shell'
    ]);
    assert.ok(settings.hooks.PreToolUse.every((g: any) => g.hooks[0].timeout === 15), 'a stuck hook gives up in 15 s');
    await assert.rejects(readFile(path.join(root, '.mcp.json'), 'utf8'));
    await setupClaude(root, { command: 'agent-memory', remove: true });
    const after = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.equal(after.hooks, undefined);
  });
});
