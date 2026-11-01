#!/usr/bin/env node
import path from 'node:path';
import { AgentMemoryService } from '../core/service.js';
import { parsePointer, formatPointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { ActivityType, AgentTask, TaskStatus } from '../models/types.js';
import { parseArgs, stringFlag, numberFlag, boolFlag } from './args.js';
import { startDashboard } from '../web/server.js';
import { startMcpServer } from '../mcp/server.js';
import { describeChange } from '../git/repo.js';
import { assertGitRepo, baselineOf, ObservedChange, runWatchPass } from '../git/watcher.js';
import { runQueue } from '../core/runner.js';

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
      for (const entry of result.messagesTrimmed) {
        console.log(`${prefix} ${entry.removed} read message(s) from ${entry.agent}'s inbox`);
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
        const tag = message.kind === 'waiting' ? ' [dependency]' : message.kind === 'overlap' ? ' [same file]' : '';
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

    case 'task': {
      const sub = parsed.positionals[0] ?? 'list';
      if (sub === 'create') {
        const task = await service.createTask({
          title: required(stringFlag(parsed.flags, 'title'), '--title'),
          createdBy: required(stringFlag(parsed.flags, 'agent'), '--agent'),
          detail: stringFlag(parsed.flags, 'detail'),
          assignedTo: stringFlag(parsed.flags, 'for'),
          pointer: parsePointer(stringFlag(parsed.flags, 'pointer')),
          parentTaskId: stringFlag(parsed.flags, 'parent'),
          dependsOn: stringFlag(parsed.flags, 'depends-on')?.split(',').map(id => id.trim()).filter(Boolean),
          reviewBy: stringFlag(parsed.flags, 'review-by'),
          reviewOpen: parsed.flags.review === true,
          reviewers: numberFlag(parsed.flags, 'reviewers')
        });
        // Building a chain from a script means capturing the id of each part to pass to
        // --depends-on. `claim` and `list` already answer in JSON; create silently ignored
        // the flag, so the only way through was parsing the sentence below.
        if (parsed.flags.json) {
          console.log(JSON.stringify(task, null, 2));
          break;
        }
        console.log(`Queued ${task.id}: ${task.title}${task.assignedTo ? ` (for ${task.assignedTo})` : ''}`);
        if (task.reviewTaskId) {
          const who = stringFlag(parsed.flags, 'review-by') ?? 'whoever is free (never the agent that did the work)';
          const panel = task.reviewers && task.reviewers > 1 ? `${task.reviewers} reviewers, majority decides; first is ` : '';
          console.log(`Review queued as ${panel}${task.reviewTaskId} for ${who}, blocked until the work lands`);
        }
        break;
      }
      if (sub === 'claim') {
        const task = await service.claimTask(required(stringFlag(parsed.flags, 'agent'), '--agent'));
        if (!task) {
          console.log('No task available.');
          break;
        }
        console.log(parsed.flags.json ? JSON.stringify(task, null, 2) : formatTask(task, true));
        break;
      }
      if (sub === 'done' || sub === 'fail' || sub === 'cancel') {
        const status = sub === 'done' ? 'DONE' : sub === 'fail' ? 'FAILED' : 'CANCELLED';
        const task = await service.finishTask(
          required(stringFlag(parsed.flags, 'id') ?? parsed.positionals[1], '--id'),
          status,
          stringFlag(parsed.flags, 'message')
        );
        console.log(`${task.id} is now ${task.status}`);
        break;
      }
      if (sub === 'list') {
        const statusFlag = stringFlag(parsed.flags, 'status');
        const tasks = await service.tasks.list({
          status: statusFlag ? (statusFlag.toUpperCase().split(',') as TaskStatus[]) : undefined,
          agent: stringFlag(parsed.flags, 'agent')
        });
        if (parsed.flags.json) {
          console.log(JSON.stringify(tasks, null, 2));
          break;
        }
        if (tasks.length === 0) {
          console.log('No tasks.');
          break;
        }
        for (const task of tasks) console.log(formatTask(task));
        break;
      }
      throw new Error(`Unknown task subcommand: ${sub}. Use create, list, claim, done, fail or cancel.`);
    }

    case 'schedule': {
      const sub = parsed.positionals[0] ?? 'list';
      if (sub === 'create') {
        const schedule = await service.createSchedule({
          cron: required(stringFlag(parsed.flags, 'cron'), '--cron'),
          title: required(stringFlag(parsed.flags, 'title'), '--title'),
          createdBy: required(stringFlag(parsed.flags, 'agent'), '--agent'),
          detail: stringFlag(parsed.flags, 'detail'),
          assignedTo: stringFlag(parsed.flags, 'for'),
          pointer: parsePointer(stringFlag(parsed.flags, 'pointer'))
        });
        console.log(`Created ${schedule.id}: "${schedule.cron}" -> ${schedule.title}`);
        console.log(`Next run: ${schedule.nextRunAt ?? 'never'}`);
        break;
      }
      if (sub === 'remove') {
        const id = required(stringFlag(parsed.flags, 'id') ?? parsed.positionals[1], '--id');
        await service.schedules.remove(id);
        console.log(`Removed ${id}`);
        break;
      }
      if (sub === 'list') {
        const schedules = await service.schedules.list();
        if (parsed.flags.json) {
          console.log(JSON.stringify(schedules, null, 2));
          break;
        }
        if (schedules.length === 0) {
          console.log('No schedules.');
          break;
        }
        for (const s of schedules) {
          console.log(`${s.id} ${s.enabled ? 'ON ' : 'OFF'} "${s.cron}" ${s.title}`);
          console.log(`  next: ${s.nextRunAt ?? '-'}  last: ${s.lastRunAt ?? 'never'}`);
        }
        break;
      }
      throw new Error(`Unknown schedule subcommand: ${sub}. Use create, list or remove.`);
    }

    case 'run': {
      const agentId = required(stringFlag(parsed.flags, 'agent'), '--agent');
      const exec = required(stringFlag(parsed.flags, 'exec'), '--exec');
      const config = await service.config();
      const lease = config.taskClaimSeconds;
      const explicitTimeout = numberFlag(parsed.flags, 'timeout');
      // The claim lease starts when the task is claimed; the timeout starts after the
      // process spawns. Giving them the same length means a task that reaches its
      // timeout has always already lost its claim, so its result is refused and the
      // work is thrown away. Finish comfortably inside the lease instead.
      const timeout = explicitTimeout ?? Math.max(1, Math.floor(lease * 0.8));
      if (explicitTimeout !== undefined && explicitTimeout >= lease) {
        console.warn(
          `warning: --timeout ${explicitTimeout}s is not below the claim lease of ${lease}s. ` +
            `A task that runs that long loses its claim before finishing, and its result is rejected. ` +
            `Raise the lease with "config --claim-seconds" or lower --timeout.`
        );
      }
      const once = boolFlag(parsed.flags, 'once');
      const options = {
        agentId,
        exec,
        intervalMs: (numberFlag(parsed.flags, 'interval') ?? 3) * 1000,
        timeoutMs: timeout * 1000,
        ...(once ? {} : { maxTasks: numberFlag(parsed.flags, "max-tasks") ?? 0 }),
        ...(numberFlag(parsed.flags, "max-cost") !== undefined ? { maxCostUsd: numberFlag(parsed.flags, "max-cost") } : {}),
        onEvent: (line: string) => console.log(line)
      };

      if (once) {
        const outcomes = await runQueue(service, options);
        console.log(`${outcomes.length} task(s) executed.`);
        break;
      }

      console.log(`Runner ${agentId} waiting for tasks. Ctrl+C to stop.`);
      let stopping = false;
      process.on('SIGINT', () => {
        stopping = true;
        console.log('\nFinishing the current task, then stopping.');
      });
      await runQueue(service, options, () => stopping);
      break;
    }

    case 'scheduler': {
      const intervalMs = Math.max(5, numberFlag(parsed.flags, 'interval') ?? 30) * 1000;
      if (boolFlag(parsed.flags, 'once')) {
        const created = await service.runDueSchedules();
        console.log(`${created.length} task(s) materialised.`);
        for (const task of created) console.log(`  ${task.id}: ${task.title}`);
        break;
      }
      console.log(`Scheduler checking every ${intervalMs / 1000}s. Ctrl+C to stop.`);
      const tick = async () => {
        try {
          for (const task of await service.runDueSchedules()) {
            console.log(`${new Date().toISOString()} queued ${task.id}: ${task.title}`);
          }
        } catch (error) {
          console.error(`scheduler: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await tick();
      const timer = setInterval(() => void tick(), intervalMs);
      process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\nScheduler stopped.');
        process.exit(0);
      });
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
      await startMcpServer(service, { agentId: stringFlag(parsed.flags, 'agent') });
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
      const autoCompact = numberFlag(parsed.flags, 'auto-compact');
      const claimSeconds = numberFlag(parsed.flags, 'claim-seconds');
      const maxAttempts = numberFlag(parsed.flags, 'max-attempts');
      const maxDepth = numberFlag(parsed.flags, 'max-depth');
      if (stale === undefined && recent === undefined && name === undefined && autoCompact === undefined
          && claimSeconds === undefined && maxAttempts === undefined && maxDepth === undefined) {
        console.log(JSON.stringify(await service.config(), null, 2));
        break;
      }
      const config = await service.updateConfig({
        ...(stale !== undefined ? { staleAfterSeconds: stale } : {}),
        ...(recent !== undefined ? { recentHistoryLimit: recent } : {}),
        ...(name !== undefined ? { projectName: name } : {}),
        ...(autoCompact !== undefined ? { autoCompactAfterEvents: autoCompact } : {}),
        ...(claimSeconds !== undefined ? { taskClaimSeconds: claimSeconds } : {}),
        ...(maxAttempts !== undefined ? { maxTaskAttempts: maxAttempts } : {}),
        ...(maxDepth !== undefined ? { maxTaskDepth: maxDepth } : {})
      });
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run agent-memory help.`);
  }
}

function formatTask(task: AgentTask, verbose = false): string {
  const who = task.assignedTo ? ` for ${task.assignedTo}` : task.claimedBy ? ` by ${task.claimedBy}` : '';
  const head = `${task.id} ${task.status.padEnd(9)} ${task.title}${who}`;
  if (!verbose) return head;
  const lines = [head];
  if (task.detail) lines.push(`  ${task.detail}`);
  if (task.pointer) lines.push(`  ${formatPointer(task.pointer)}`);
  lines.push(`  depth ${task.depth}, attempt ${task.attempts}`);
  return lines.join('\n');
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
  console.log(`Agent Shared Memory\n\nUsage:\n  agent-memory <command> [options]\n\nCommands:\n  init [--name PROJECT] [--stale 60] [--recent 20]\n  register --agent AGENT-01 [--role Backend] [--task AUTH-184] [--force]\n  unregister --agent AGENT-01\n  status [--json]\n  memory\n  log [--limit 20] [--agent AGENT-01] [--json]\n  send --from AGENT-01 --to AGENT-02 --message "..." [--pointer "..."]\n  inbox --agent AGENT-02 [--all] [--peek] [--json]\n  heartbeat --agent AGENT-01\n  intent|reading|found|changed|created|testing|waiting|done|note\n      --agent AGENT-01 --message "..."\n      [--task TASK] [--pointer "file::symbol::parameter"]\n      [--reason "..."] [--for AGENT-02]\n  config [--name PROJECT] [--stale 60] [--recent 20] [--auto-compact 5000] [--max-depth 3]\n  compact [--keep 500] [--history] [--dry-run]\n\nWork queue:\n  task create --agent A --title "..." [--detail "..."] [--for B] [--pointer "..."]\n                [--review-by C]        queue a review that must accept the work
                [--review]             same, but open to whoever is free (never the doer)
                [--reviewers 3]        queue an open panel (1-9); majority decides\n                [--depends-on T1,T2]   stay out of the queue until all of them are DONE
                [--json]               print the task, so a chain can capture its id\n  task list [--status OPEN] [--agent A] [--json]\n  task claim --agent A\n  task done|fail|cancel --id T-XXX [--message "..."]\n  schedule create --agent A --cron "0 9 * * 1-5" --title "..." [--for B]\n  schedule list [--json]\n  schedule remove --id S-XXX\n  run --agent A --exec "<command>" [--once] [--interval 3] [--timeout 900]\n  scheduler [--interval 30] [--once]\n\n  watch [--interval 3] [--once] [--id GIT-WATCHER] [--dry-run]\n  serve [--port 4317]\n  mcp [--agent AGENT-01]   MCP server over stdio (Claude Code, Codex, Cursor...)\n                           --agent fixes the identity and drops it from every tool\n\nGlobal:\n  --root PATH   Project root (defaults to current directory)\n\nPointer examples:\n  src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)\n  src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)::orderId\n`);
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

