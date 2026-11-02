/**
 * The shared memory enforced where agents actually write, instead of only where they look.
 *
 * Measured with real agents: a warning in a tool result reached the agent that arrived
 * second and not the one that wrote last, and work was erased. A notice helps only if it is
 * seen before the write. These hooks put it there without the model having to remember:
 *
 *   session-start  hands the agent the rules, facts, reservations and ready work (`prime`);
 *   pre-write      refuses a write to a file another agent reserved, or one another agent
 *                  changed since this one was told about it -- once, with the reason;
 *   post-write     records the change, which tells every other agent on the file that its
 *                  copy is stale;
 *   session-end    releases what the session held.
 *
 * And a git pre-commit hook refuses a commit that touches files reserved by someone else.
 *
 * Hooks never fail the editor because of the memory itself: a missing .agents/ or a broken
 * store lets the write through. Only a real conflict blocks.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { AgentMemoryService } from '../core/service.js';
import { localTime } from '../utils/time.js';

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

export async function runClaudeHook(event: string, input: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutcome> {
  let payload: Record<string, any> = {};
  try {
    payload = input.trim() ? JSON.parse(input) : {};
  } catch {
    return { exitCode: 0 };
  }
  const root = findRoot(payload.cwd ?? process.cwd());
  if (!root) return { exitCode: 0 };

  try {
    const service = new AgentMemoryService(root);
    const agentId = sessionAgent(env, payload.session_id);
    if (!(await service.store.stateExists(agentId))) await service.register(agentId, 'Claude Code').catch(() => undefined);

    if (event === 'session-start') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: await service.prime(agentId) } })
      };
    }

    if (event === 'session-end') {
      await service.release(agentId);
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

      // A notice that another agent changed this file since: shown once, before the write
      // it is about, then the next attempt goes through.
      const { unread } = await service.readInbox(agentId, { markRead: false });
      const stale = unread.filter(m => m.kind === 'overlap' && m.pointer?.file === rel);
      if (stale.length > 0) {
        await service.readInbox(agentId);
        return {
          exitCode: 2,
          stderr: `${stale.map(m => m.body).join('\n')}\nRead ${rel} again before writing it, keep the other agent's change, then write.`
        };
      }
      // Announce the write before it happens: whoever else is on the file hears of it now.
      await service.activity({ agentId, type: 'INTENT', description: `${payload.tool_name} ${rel}`, pointer: { file: rel } });
    }
    return { exitCode: 0 };
  } catch {
    // The memory must never be the reason an editor cannot write.
    return { exitCode: 0 };
  }
}

/** Refuses a commit that touches a file another agent holds exclusively. */
export async function runGitPreCommit(root: string, env: NodeJS.ProcessEnv = process.env): Promise<HookOutcome> {
  if (!findRoot(root)) return { exitCode: 0 };
  let staged: string[];
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return { exitCode: 0 };
  }
  const service = new AgentMemoryService(root);
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

/** How to call this CLI from a hook: the script that is running now, through node. */
export function selfCommand(): string {
  const script = process.argv[1] ? path.resolve(process.argv[1]) : 'agent-memory';
  return /\.(c?js|mjs)$/.test(script) ? `node "${script.split(path.sep).join('/')}"` : 'agent-memory';
}

/**
 * Wires the hooks and the MCP server into a project's Claude Code settings. Idempotent: our
 * entries are recognised by their command and replaced, everything else is left alone.
 */
export async function setupClaude(root: string, options: { remove?: boolean; command?: string } = {}): Promise<string[]> {
  const command = options.command ?? selfCommand();
  const done: string[] = [];

  const settingsFile = path.join(root, '.claude', 'settings.json');
  const settings = await readJsonFile(settingsFile);
  settings.hooks ??= {};
  const wanted: Record<string, { matcher: string; event: string }> = {
    SessionStart: { matcher: '', event: 'session-start' },
    PreToolUse: { matcher: 'Write|Edit|MultiEdit|NotebookEdit', event: 'pre-write' },
    PostToolUse: { matcher: 'Write|Edit|MultiEdit|NotebookEdit', event: 'post-write' },
    SessionEnd: { matcher: '', event: 'session-end' }
  };
  for (const [hookEvent, spec] of Object.entries(wanted)) {
    const groups: any[] = Array.isArray(settings.hooks[hookEvent]) ? settings.hooks[hookEvent] : [];
    const others = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !String(h.command ?? '').includes(HOOK_MARK)) }))
      .filter(g => g.hooks.length > 0);
    if (!options.remove) others.push({ matcher: spec.matcher, hooks: [{ type: 'command', command: `${command}${HOOK_MARK}${spec.event}` }] });
    if (others.length) settings.hooks[hookEvent] = others;
    else delete settings.hooks[hookEvent];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  done.push(`${options.remove ? 'removed hooks from' : 'hooks written to'} .claude/settings.json`);

  const mcpFile = path.join(root, '.mcp.json');
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
