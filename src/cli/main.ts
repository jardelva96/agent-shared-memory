#!/usr/bin/env node
import path from 'node:path';
import { AgentMemoryService } from '../core/service.js';
import { parsePointer, formatPointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { ActivityType } from '../models/types.js';
import { parseArgs, stringFlag, numberFlag, boolFlag } from './args.js';
import { startDashboard } from '../web/server.js';
import { startMcpServer } from '../mcp/server.js';
import { describeChange } from '../git/repo.js';
import { assertGitRepo, baselineOf, ObservedChange, runWatchPass } from '../git/watcher.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const root = path.resolve(stringFlag(parsed.flags, 'root') ?? process.cwd());
  const service = new AgentMemoryService(root);
  const command = parsed.command;

  if (!command || command === 'help' || parsed.flags.help) {
    printHelp();
    return;
  }

  switch (command) {
    case 'init': {
      const name = stringFlag(parsed.flags, 'name') ?? (parsed.positionals.join(' ') || path.basename(root));
      const stale = numberFlag(parsed.flags, 'stale');
      const recent = numberFlag(parsed.flags, 'recent');
      const config = await service.init(name, {
        ...(stale !== undefined ? { staleAfterSeconds: stale } : {}),
        ...(recent !== undefined ? { recentHistoryLimit: recent } : {})
      });
      console.log(`Initialized Agent Shared Memory for "${config.projectName}" in ${root}`);
      break;
    }

    case 'register': {
      const agentId = required(stringFlag(parsed.flags, 'agent') ?? parsed.positionals[0], 'agent id');
      const role = stringFlag(parsed.flags, 'role');
      const task = stringFlag(parsed.flags, 'task');
      if (boolFlag(parsed.flags, 'force') && (await service.store.stateExists(agentId))) {
        const state = await service.reset(agentId, role, task);
        console.log(`Reset ${state.id} (new session ${state.sessionId}); history preserved`);
        break;
      }
      const state = await service.register(agentId, role, task);
      console.log(`Registered ${state.id} (session ${state.sessionId})`);
      break;
    }

    case 'unregister': {
      const agentId = required(stringFlag(parsed.flags, 'agent') ?? parsed.positionals[0], 'agent id');
      const state = await service.unregister(agentId);
      console.log(`Unregistered ${state.id}; history kept at .agents/history/${state.id}.md`);
      break;
    }

    case 'log': {
      const limit = numberFlag(parsed.flags, 'limit') ?? 20;
      const agentId = stringFlag(parsed.flags, 'agent');
      // Over-fetch so an agent filter can still fill the requested window.
      const activities = await service.store.recentActivities(agentId ? limit * 10 : limit);
      const events = (agentId ? activities.filter(a => a.agentId === agentId) : activities).slice(0, limit);
      if (parsed.flags.json) {
        console.log(JSON.stringify(events, null, 2));
        break;
      }
      if (events.length === 0) {
        console.log('No events recorded yet.');
        break;
      }
      for (const event of events) {
        const pointer = event.pointer ? ` | ${formatPointer(event.pointer)}` : '';
        console.log(`${event.timestamp} | ${event.agentId} | ${event.type} | ${event.description}${pointer}`);
      }
      break;
    }

    case 'compact': {
      const result = await service.compact({
        keep: numberFlag(parsed.flags, 'keep'),
        history: boolFlag(parsed.flags, 'history'),
        dryRun: boolFlag(parsed.flags, 'dry-run')
      });
      const prefix = result.dryRun ? 'Would archive' : 'Archived';
      console.log(`${prefix} ${result.eventsArchived} of ${result.eventsTotal} event(s).`);
      if (result.eventsArchiveFile) console.log(`Events archive: ${result.eventsArchiveFile}`);
      for (const entry of result.historyArchived) {
        console.log(`${prefix} history for ${entry.agent}${result.dryRun ? '' : ` -> ${entry.file}`}`);
      }
      if (result.dryRun) console.log('\nDry run: nothing was written.');
      break;
    }

    case 'status': {
      const config = await service.config();
      const states = (await service.states()).sort((a, b) => a.id.localeCompare(b.id));
      const unread = await Promise.all(states.map(s => service.messages.unreadCount(s.id)));
      if (parsed.flags.json) {
        console.log(JSON.stringify(
          states.map((s, i) => ({ ...s, effectiveStatus: effectiveStatus(s, config), unread: unread[i] })),
          null,
          2
        ));
        break;
      }
      printStatus(states.map((s, i) => ({
        agent: s.id,
        status: effectiveStatus(s, config),
        task: s.task ?? '-',
        now: s.current?.description ?? '-',
        pointer: formatPointer(s.current?.pointer),
        inbox: unread[i] > 0 ? String(unread[i]) : '-'
      })));
      break;
    }

    case 'send': {
      const from = required(stringFlag(parsed.flags, 'from'), '--from');
      const to = required(stringFlag(parsed.flags, 'to'), '--to');
      const body = required(stringFlag(parsed.flags, 'message'), '--message');
      const message = await service.sendMessage({
        from,
        to,
        body,
        pointer: parsePointer(stringFlag(parsed.flags, 'pointer'))
      });
      console.log(`Delivered to ${message.to} (${message.id})`);
      break;
    }

    case 'inbox': {
      const agentId = required(stringFlag(parsed.flags, 'agent') ?? parsed.positionals[0], '--agent');
      const showAll = boolFlag(parsed.flags, 'all');
      const result = await service.readInbox(agentId, { markRead: !boolFlag(parsed.flags, 'peek') });
      const shown = showAll ? result.messages : result.unread;

      if (parsed.flags.json) {
        console.log(JSON.stringify(shown, null, 2));
        break;
      }
      if (shown.length === 0) {
        console.log(showAll ? 'Inbox is empty.' : 'No unread messages.');
        break;
      }
      for (const message of shown) {
        const tag = message.kind === 'waiting' ? ' [dependency]' : '';
        console.log(`${message.timestamp} | from ${message.from}${tag}`);
        console.log(`  ${message.body}`);
        if (message.pointer) console.log(`  ${formatPointer(message.pointer)}`);
      }
      console.log(`\n${shown.length} message(s)${showAll ? '' : ' unread'}.`);
      break;
    }

    case 'memory': {
      console.log(await service.store.readSharedMemory());
      break;
    }

    case 'heartbeat': {
      const agentId = required(stringFlag(parsed.flags, 'agent') ?? parsed.positionals[0], 'agent id');
      const state = await service.heartbeat(agentId);
      console.log(`${state.id} heartbeat ${state.lastHeartbeatAt}`);
      break;
    }

    case 'intent':
    case 'reading':
    case 'found':
    case 'changed':
    case 'created':
    case 'testing':
    case 'waiting':
    case 'done':
    case 'note': {
      const type = command.toUpperCase() as ActivityType;
      const agentId = required(stringFlag(parsed.flags, 'agent'), '--agent');
      const description = required(stringFlag(parsed.flags, 'message') ?? stringFlag(parsed.flags, 'description'), '--message');
      const pointer = parsePointer(stringFlag(parsed.flags, 'pointer'));
      const result = await service.activity({
        agentId,
        type,
        description,
        pointer,
        task: stringFlag(parsed.flags, 'task'),
        reason: stringFlag(parsed.flags, 'reason'),
        waitingFor: stringFlag(parsed.flags, 'for')
      });
      console.log(`${type} recorded for ${agentId}`);
      if (pointer) console.log(`Pointer: ${formatPointer(pointer)}`);
      if (result.conflicts.length > 0) {
        console.warn(`\nWARNING: ${result.conflicts.length} active overlap(s) detected:`);
        for (const c of result.conflicts) {
          console.warn(`- ${c.agentId} [${c.status}] ${c.exact ? 'EXACT' : 'RELATED'} ${formatPointer(c.pointer)} :: ${c.description}`);
        }
      }
      break;
    }

    case 'watch': {
      await assertGitRepo(root);
      const watcherId = stringFlag(parsed.flags, 'id');
      const record = !boolFlag(parsed.flags, 'dry-run');

      if (boolFlag(parsed.flags, 'once')) {
        // Empty baseline: report everything the working tree currently holds.
        const result = await runWatchPass(service, new Map(), { watcherId, record });
        if (result.observed.length === 0) {
          console.log('Working tree is clean.');
          break;
        }
        for (const entry of result.observed) console.log(formatObservation(entry));
        console.log(
          `\n${result.observed.length} change(s): ${result.undeclared} undeclared, ${result.ambiguous} ambiguous.`
        );
        if (result.undeclared > 0) process.exitCode = 1;
        break;
      }

      const intervalMs = Math.max(1, numberFlag(parsed.flags, 'interval') ?? 3) * 1000;
      const seen = await baselineOf(root);
      console.log(
        `Watching ${root} every ${intervalMs / 1000}s (${seen.size} pre-existing change(s) ignored). Ctrl+C to stop.`
      );

      let running = false;
      const timer = setInterval(async () => {
        if (running) return; // A slow pass must not overlap the next tick.
        running = true;
        try {
          const result = await runWatchPass(service, seen, { watcherId, record });
          for (const entry of result.observed) console.log(formatObservation(entry));
        } catch (error) {
          console.error(`watch: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          running = false;
        }
      }, intervalMs);

      process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\nWatcher stopped.');
        process.exit(0);
      });
      break;
    }

    case 'mcp': {
      // stdout belongs to the JSON-RPC transport from here on; never log to it.
      startMcpServer(service);
      break;
    }

    case 'serve': {
      const port = numberFlag(parsed.flags, 'port') ?? 4317;
      await startDashboard(service, port);
      console.log(`Dashboard: http://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop.');
      break;
    }

    case 'config': {
      const stale = numberFlag(parsed.flags, 'stale');
      const recent = numberFlag(parsed.flags, 'recent');
      const name = stringFlag(parsed.flags, 'name');
      if (stale === undefined && recent === undefined && name === undefined) {
        console.log(JSON.stringify(await service.config(), null, 2));
        break;
      }
      const config = await service.updateConfig({
        ...(stale !== undefined ? { staleAfterSeconds: stale } : {}),
        ...(recent !== undefined ? { recentHistoryLimit: recent } : {}),
        ...(name !== undefined ? { projectName: name } : {})
      });
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run agent-memory help.`);
  }
}

function formatObservation(entry: ObservedChange): string {
  const owner =
    entry.attribution === 'declared'
      ? entry.agentId!
      : entry.attribution === 'ambiguous'
        ? `AMBIGUOUS(${entry.candidates.join('|')})`
        : 'UNDECLARED';
  return `${owner.padEnd(22)} ${entry.change.path} (${describeChange(entry.change)})`;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function printStatus(
  rows: Array<{agent:string;status:string;task:string;now:string;pointer:string;inbox:string}>
): void {
  if (rows.length === 0) {
    console.log('No agents registered.');
    return;
  }
  const headers = ['AGENT', 'STATUS', 'TASK', 'NOW', 'POINTER', 'INBOX'];
  const values = rows.map(r => [r.agent, r.status, r.task, r.now, r.pointer, r.inbox]);
  const widths = headers.map((h, i) => Math.min(48, Math.max(h.length, ...values.map(v => v[i].length))));
  const line = (parts: string[]) => parts.map((p, i) => truncate(p, widths[i]).padEnd(widths[i])).join(' | ');
  console.log(line(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('-|-'));
  for (const row of values) console.log(line(row));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function printHelp(): void {
  console.log(`Agent Shared Memory\n\nUsage:\n  agent-memory <command> [options]\n\nCommands:\n  init [--name PROJECT] [--stale 60] [--recent 20]\n  register --agent AGENT-01 [--role Backend] [--task AUTH-184] [--force]\n  unregister --agent AGENT-01\n  status [--json]\n  memory\n  log [--limit 20] [--agent AGENT-01] [--json]\n  send --from AGENT-01 --to AGENT-02 --message "..." [--pointer "..."]\n  inbox --agent AGENT-02 [--all] [--peek] [--json]\n  heartbeat --agent AGENT-01\n  intent|reading|found|changed|created|testing|waiting|done|note\n      --agent AGENT-01 --message "..."\n      [--task TASK] [--pointer "file::symbol::parameter"]\n      [--reason "..."] [--for AGENT-02]\n  config [--name PROJECT] [--stale 60] [--recent 20]\n  compact [--keep 500] [--history] [--dry-run]\n  watch [--interval 3] [--once] [--id GIT-WATCHER] [--dry-run]\n  serve [--port 4317]\n  mcp           MCP server over stdio (for Claude Code, Codex, Cursor...)\n\nGlobal:\n  --root PATH   Project root (defaults to current directory)\n\nPointer examples:\n  src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)\n  src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)::orderId\n`);
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
