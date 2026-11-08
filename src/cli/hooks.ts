/** Claude Code hooks and the git pre-commit guard. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { AgentMemoryService } from '../core/service.js';
import { isReadOnly, parseShell, ParsedShell, summarize } from '../core/shellguard.js';
import { dirtyFiles, findRepo } from '../git/repo.js';
import { localTime, nowIso } from '../utils/time.js';
import { remoteFromEnv, remoteService } from '../remote/client.js';

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  // Loaded here: a hook call that runs no git does not pay for child_process.
  const { execFileSync } = await import('node:child_process');
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface HookOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** The nearest folder at or above `start` that holds an initialised .agents/. */
export function findRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, '.agents', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The agent a Claude Code session acts as: AGENT_MEMORY_AGENT, or one id per session. */
export function sessionAgent(env: NodeJS.ProcessEnv, sessionId?: string): string {
  const pinned = env.AGENT_MEMORY_AGENT?.trim();
  if (pinned) return pinned;
  const tail = (sessionId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
  return `CC-${tail || 'SESSION'}`;
}

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
const HOOK_EVENTS = ['session-start', 'pre-write', 'post-write', 'pre-shell', 'post-shell', 'session-end'];

/** Another session counts as still in a checkout if it was seen there this recently. */
const STILL_THERE_MS = 10 * 60_000;

/** The checkout a folder belongs to, as a root-relative key ("." for the root), if it is under the root. */
function placeOf(root: string, dir: string): { key: string; repo: string } | undefined {
  const repo = findRepo(dir);
  if (!repo) return undefined;
  const rel = path.relative(root, repo).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return { key: rel || '.', repo };
}

function placesOf(root: string, parsed: ParsedShell): Map<string, string> {
  const places = new Map<string, string>();
  for (const dir of parsed.dirs) {
    const place = placeOf(root, dir);
    if (place) places.set(place.key, place.repo);
  }
  return places;
}

function ago(iso: string | number): string {
  const minutes = Math.max(0, Math.round((Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso))) / 60_000));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/**
 * Before a shell command: a git command that changes a checkout (switch branch, stash, reset, pull,
 * commit everything...) is refused while another session works in that checkout and there are
 * recent changes this session did not make, or while another session just moved its branch.
 */
async function guardShell(service: AgentMemoryService, root: string, agentId: string, parsed: ParsedShell): Promise<HookOutcome | undefined> {
  const risky = parsed.git.filter(step => step.risk);
  if (risky.length === 0) return undefined;
  const minutes = (await service.config()).guardMinutes ?? 30;
  const notes: Array<[string, string]> = [];
  const problems: string[] = [];

  for (const step of risky) {
    const place = placeOf(root, step.dir);
    if (!place) continue;
    const gitNote = (): void => {
      if (step.risk === 'branch') notes.push([`git: ${step.text}`, place.key]);
    };
    if (minutes <= 0) {
      gitNote();
      continue;
    }

    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const context = await service.guardContext(agentId, place.key, since);
    const mine = new Set(context.mine);
    const prefix = place.key === '.' ? '' : `${place.key}/`;
    const sinceMs = Date.parse(since);
    const foreign = (await dirtyFiles(place.repo, { untracked: step.risk === 'sweep' })).filter(
      f => f.modifiedMs !== undefined && f.modifiedMs >= sinceMs && !mine.has(prefix + f.path)
    );
    const stillThere = new Set(context.others.filter(o => Date.now() - Date.parse(o.at) <= STILL_THERE_MS).map(o => o.id));
    const theirGit = step.risk === 'branch' ? context.gitOps.filter(op => stillThere.has(op.id)) : [];

    // The rule is the same with or without asm-ok: with it the guard never blocks, it only notes what it would have done.
    const wouldBlock = (foreign.length > 0 && context.others.length > 0) || theirGit.length > 0;
    const summary = `${step.text} (${foreign.length} change(s) not made here; others: ${context.others.map(o => o.id).join(', ')})`;
    if (wouldBlock && parsed.acknowledged !== undefined) {
      notes.push([`guard: let through by asm-ok (${parsed.acknowledged || 'no reason given'}), would have blocked: ${summary}`, place.key]);
      gitNote();
    } else if (wouldBlock) {
      const lines = [`\`${step.text}\` would change the checkout ${place.key} while another session works in it.`];
      if (foreign.length > 0) {
        lines.push(`Uncommitted changes this session did not make, from the last ${minutes} min:`);
        for (const f of foreign.slice(0, 6)) lines.push(`  ${f.path} (${ago(f.modifiedMs!)})`);
        if (foreign.length > 6) lines.push(`  ... and ${foreign.length - 6} more`);
      }
      for (const op of theirGit.slice(0, 3)) lines.push(`${op.id} ran \`${op.description}\` here ${ago(op.at)}.`);
      lines.push(`Sessions seen in ${place.key}: ${context.others.map(o => `${o.id} (${o.how}, ${ago(o.at)}${o.doing ? `: ${o.doing.slice(0, 60)}` : ''})`).join('; ')}.`);
      problems.push(lines.join('\n'));
      notes.push([`guard: blocked ${summary}`, place.key]);
    } else if (parsed.acknowledged !== undefined) {
      notes.push([`guard: asm-ok not needed (${parsed.acknowledged || 'no reason given'}): ${step.text}`, place.key]);
      gitNote();
    } else {
      if (foreign.length > 0) notes.push([`guard: let through ${step.text} with ${foreign.length} recent change(s) nobody here claimed`, place.key]);
      gitNote();
    }
  }

  // A blocked command did not run: only its block is written down, not its git steps.
  for (const [description, place] of problems.length ? notes.filter(([d]) => d.startsWith('guard: blocked')) : notes) {
    await service.noteGuard(agentId, description, place);
  }
  if (problems.length === 0) return undefined;
  return {
    exitCode: 2,
    stderr:
      `${problems.join('\n\n')}\n\n` +
      'Do not switch, stash, reset or commit everything under another session: message it, or ask the user.\n' +
      'If those changes are yours (made through the shell), run the same command again ending with `# asm-ok: <why>`.'
  };
}

/** After a shell command: the files it wrote become this session's, so its own changes never block it. */
async function noteShellWrites(service: AgentMemoryService, root: string, agentId: string, parsed: ParsedShell): Promise<void> {
  const files: Array<{ path: string; modifiedMs: number }> = [];
  for (const [key, repo] of placesOf(root, parsed)) {
    const prefix = key === '.' ? '' : `${key}/`;
    for (const f of await dirtyFiles(repo, { untracked: true })) {
      if (f.modifiedMs !== undefined) files.push({ path: prefix + f.path, modifiedMs: f.modifiedMs });
    }
  }
  if (files.length) await service.noteShellWrites(agentId, files);
}

export async function runClaudeHook(event: string, input: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutcome> {
  // A misspelled event would do nothing and exit 0, so a broken hook setup looked like a working one.
  if (!HOOK_EVENTS.includes(event)) {
    return { exitCode: 1, stderr: `agent-memory: unknown hook event "${event}". Use one of: ${HOOK_EVENTS.join(', ')}.` };
  }
  let payload: Record<string, any> = {};
  try {
    payload = input.trim() ? JSON.parse(input) : {};
  } catch {
    return { exitCode: 0 };
  }
  // With a hub, this checkout needs no .agents/ of its own: the memory lives on the hub.
  const remote = remoteFromEnv(env);
  const cwd = payload.cwd ?? process.cwd();
  const root = findRoot(cwd) ?? (remote ? (await gitTopLevel(cwd)) ?? cwd : undefined);
  if (!root) return { exitCode: 0 };

  try {
    const service = remote ? remoteService(root, remote) : new AgentMemoryService(root);
    const agentId = sessionAgent(env, payload.session_id);
    if (!(await service.store.stateExists(agentId))) await service.register(agentId, 'Claude Code').catch(() => undefined);

    if (event === 'session-start') {
      // Sessions that closed without SessionEnd would otherwise pile up on the panel forever.
      await service.forgetIdleSessions().catch(() => []);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: await service.prime(agentId) } })
      };
    }

    if (event === 'session-end') {
      await service.release(agentId);
      await service.notePlaces(agentId, [], { clear: true });
      return { exitCode: 0 };
    }

    if ((event === 'pre-shell' || event === 'post-shell') && SHELL_TOOLS.test(payload.tool_name ?? '')) {
      const command = String(payload.tool_input?.command ?? '');
      const parsed = parseShell(command, cwd);
      if (event === 'pre-shell') {
        await service.notePlaces(agentId, [...placesOf(root, parsed).keys()], { startedAt: nowIso(), summary: summarize(command) });
        return (await guardShell(service, root, agentId, parsed)) ?? { exitCode: 0 };
      }
      if (!isReadOnly(command)) await noteShellWrites(service, root, agentId, parsed);
      return { exitCode: 0 };
    }

    if ((event === 'pre-write' || event === 'post-write') && WRITE_TOOLS.test(payload.tool_name ?? '')) {
      const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
      if (typeof target !== 'string') return { exitCode: 0 };
      const rel = path.relative(root, path.resolve(root, target)).split(path.sep).join('/');
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.agents/')) return { exitCode: 0 };

      if (event === 'post-write') {
        await service.activity({ agentId, type: 'CHANGED', description: `${payload.tool_name} ${rel}`, pointer: { file: rel } });
        return { exitCode: 0 };
      }

      const blocking = (await service.reservations.holders(rel, agentId)).filter(r => r.exclusive);
      if (blocking.length > 0) {
        const r = blocking[0];
        return {
          exitCode: 2,
          stderr:
            `${rel} is reserved by ${r.agentId} (exclusive until ${localTime(r.expiresAt)}${r.reason ? `: ${r.reason}` : ''}). ` +
            `Do not write it now. Pick other work, or ask ${r.agentId} to release it (memory_send).`
        };
      }

      // Another agent changed this file: block this write once so the agent sees it; the retry goes
      // through.
      const { unread } = await service.readInbox(agentId, { markRead: false });
      const stale = unread.filter(m => m.kind === 'overlap' && m.pointer?.file === rel);
      if (stale.length > 0) {
        await service.readInbox(agentId);
        return {
          exitCode: 2,
          stderr: `${stale.map(m => m.body).join('\n')}\nRead ${rel} again before writing it, keep the other agent's change, then write.`
        };
      }
      // Announce the write so other agents on this file are notified.
      await service.activity({ agentId, type: 'INTENT', description: `${payload.tool_name} ${rel}`, pointer: { file: rel } });
    }
    return { exitCode: 0 };
  } catch {
    // An error in the memory must not block the editor.
    return { exitCode: 0 };
  }
}

/** Refuses a commit that touches a file another agent holds exclusively. */
export async function runGitPreCommit(root: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutcome> {
  const remote = remoteFromEnv(env);
  if (!remote && !findRoot(root)) return { exitCode: 0 };
  const { execFileSync } = await import('node:child_process');
  let staged: string[];
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return { exitCode: 0 };
  }
  const service = remote ? remoteService(root, remote) : new AgentMemoryService(root);
  const me = env.AGENT_MEMORY_AGENT?.trim();
  const problems: string[] = [];
  for (const file of staged) {
    for (const r of await service.reservations.holders(file, me)) {
      if (r.exclusive) problems.push(`${file}: reserved by ${r.agentId} until ${localTime(r.expiresAt)}${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
  if (problems.length === 0) return { exitCode: 0 };
  return {
    exitCode: 1,
    stderr:
      `Commit refused: other agents hold these files.\n${problems.map(p => `  ${p}`).join('\n')}\n` +
      'Wait for them to release, or set AGENT_MEMORY_AGENT to the agent that holds them.'
  };
}

const HOOK_MARK = ' hook claude ';
const HOOK_TIMEOUT_SECONDS = 15;

/** How to call this CLI from a hook: the script that is running now, through node. */
export function selfCommand(): string {
  const script = process.argv[1] ? path.resolve(process.argv[1]) : 'agent-memory';
  return /\.(c?js|mjs)$/.test(script) ? `node "${script.split(path.sep).join('/')}"` : 'agent-memory';
}

/** Wires the hooks (and, unless `hooksOnly`, the MCP server) into a project's Claude Code settings. */
export async function setupClaude(root: string, options: { remove?: boolean; command?: string; hooksOnly?: boolean } = {}): Promise<string[]> {
  const command = options.command ?? selfCommand();
  const done: string[] = [];

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const settings = await readJsonFile(settingsFile);
  settings.hooks ??= {};
  const wanted: Array<{ hookEvent: string; matcher: string; event: string }> = [
    { hookEvent: 'SessionStart', matcher: '', event: 'session-start' },
    { hookEvent: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit', event: 'pre-write' },
    { hookEvent: 'PreToolUse', matcher: 'Bash|PowerShell', event: 'pre-shell' },
    { hookEvent: 'PostToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit', event: 'post-write' },
    { hookEvent: 'PostToolUse', matcher: 'Bash|PowerShell', event: 'post-shell' },
    { hookEvent: 'SessionEnd', matcher: '', event: 'session-end' }
  ];
  for (const hookEvent of new Set(wanted.map(w => w.hookEvent))) {
    const groups: any[] = Array.isArray(settings.hooks[hookEvent]) ? settings.hooks[hookEvent] : [];
    const others = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !String(h.command ?? '').includes(HOOK_MARK)) }))
      .filter(g => g.hooks.length > 0);
    if (!options.remove) {
      for (const spec of wanted.filter(w => w.hookEvent === hookEvent)) {
        // A memory stuck on a lock must not hold the editor for the default minute on every tool call.
        others.push({ matcher: spec.matcher, hooks: [{ type: 'command', command: `${command}${HOOK_MARK}${spec.event}`, timeout: HOOK_TIMEOUT_SECONDS }] });
      }
    }
    if (others.length) settings.hooks[hookEvent] = others;
    else delete settings.hooks[hookEvent];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  done.push(`${options.remove ? 'removed hooks from' : 'hooks written to'} .claude/settings.json`);

  // Hooks only: no MCP server process per session, and an existing entry is left as it is.
  if (options.hooksOnly && !options.remove) return done;

  const mcpFile = path.join(root, '.mcp.json');
  if (options.remove && !existsSync(mcpFile)) return done;
  const mcp = await readJsonFile(mcpFile);
  mcp.mcpServers ??= {};
  if (options.remove) delete mcp.mcpServers['agent-memory'];
  else {
    const [bin, ...args] = splitCommand(command);
    mcp.mcpServers['agent-memory'] = { command: bin, args: [...args, 'mcp'] };
  }
  await writeFile(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
  done.push(`${options.remove ? 'removed' : 'added'} the agent-memory MCP server in .mcp.json`);
  return done;
}

/** Installs (or removes) the git pre-commit guard, leaving any other pre-commit hook in place. */
export async function setupGit(root: string, options: { remove?: boolean; command?: string } = {}): Promise<string[]> {
  const hooksDir = path.join(root, '.git', 'hooks');
  if (!existsSync(path.join(root, '.git'))) throw new Error(`${root} is not the root of a git repository.`);
  const file = path.join(hooksDir, 'pre-commit');
  const line = `${options.command ?? selfCommand()} hook pre-commit || exit 1`;
  const current = existsSync(file) ? await readFile(file, 'utf8') : '#!/bin/sh\n';
  const kept = current.split('\n').filter(l => !l.includes(' hook pre-commit')).join('\n').replace(/\n+$/, '\n');
  const next = options.remove ? kept : `${kept}${line}\n`;
  await mkdir(hooksDir, { recursive: true });
  await writeFile(file, next, 'utf8');
  await chmod(file, 0o755).catch(() => undefined);
  return [`${options.remove ? 'removed the guard from' : 'guard added to'} .git/hooks/pre-commit`];
}

async function readJsonFile(file: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

function splitCommand(command: string): string[] {
  return (command.match(/"[^"]*"|\S+/g) ?? []).map(part => part.replace(/^"|"$/g, ''));
}
