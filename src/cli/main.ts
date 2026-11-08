#!/usr/bin/env node
import path from 'node:path';
import { AgentMemoryService } from '../core/service.js';
import { parsePointer, formatPointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { ActivityType, AgentTask, TaskStatus } from '../models/types.js';
import { parseArgs, stringFlag, numberFlag, boolFlag } from './args.js';
import { describeChange } from '../git/repo.js';
import type { ObservedChange } from '../git/watcher.js';
import { readFile } from 'node:fs/promises';
import { localTime } from '../utils/time.js';
import { runClaudeHook, runGitPreCommit, setupClaude, setupGit } from './hooks.js';
import { remoteService } from '../remote/client.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const root = path.resolve(stringFlag(parsed.flags, 'root') ?? process.cwd());
  const command = parsed.command;
  // --remote (or AGENT_MEMORY_REMOTE) points at a hub on another machine: coordination goes
  // there, while this checkout's files stay local.
  const remoteUrl = command === 'hub' ? undefined : (stringFlag(parsed.flags, 'remote') ?? process.env.AGENT_MEMORY_REMOTE);
  const remoteToken = stringFlag(parsed.flags, 'token') ?? process.env.AGENT_MEMORY_TOKEN;
  if (remoteUrl && !remoteToken) throw new Error('--remote needs --token (or AGENT_MEMORY_TOKEN): the one the hub printed.');
  const service = remoteUrl && remoteToken ? remoteService(root, { url: remoteUrl, token: remoteToken }) : new AgentMemoryService(root);

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

    case 'forget-idle': {
      const forgotten = await service.forgetIdleSessions({ force: true });
      const hours = (await service.config()).forgetOfflineAfterHours ?? 24;
      console.log(
        hours <= 0
          ? 'forgetOfflineAfterHours is 0: sessions are never forgotten.'
          : forgotten.length
            ? `Forgot ${forgotten.length} session(s) silent for over ${hours} h: ${forgotten.join(', ')}. Their history stays.`
            : `No session has been silent for over ${hours} h without holding a task or a reservation.`
      );
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

    case 'guard-log': {
      // What the shell guard blocked, let through, or was told to let through: the record to learn from.
      const limit = numberFlag(parsed.flags, 'limit') ?? 30;
      const events = (await service.store.recentActivities(5000))
        .filter(e => e.type === 'NOTE' && (e.description.startsWith('guard: ') || e.description.startsWith('git: ')))
        .slice(-limit);
      if (parsed.flags.json) {
        console.log(JSON.stringify(events, null, 2));
        break;
      }
      if (events.length === 0) {
        console.log('The shell guard has nothing on record yet.');
        break;
      }
      for (const e of events) console.log(`${e.timestamp} | ${e.agentId} | ${e.pointer?.file ?? '-'} | ${e.description}`);
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
          reviewers: numberFlag(parsed.flags, 'reviewers'),
          priority: numberFlag(parsed.flags, 'priority')
        });
        // Lets a script capture the id to pass to --depends-on.
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
      if (sub === 'show') {
        const history = await service.taskHistory(required(stringFlag(parsed.flags, 'id') ?? parsed.positionals[1], 'task id'));
        if (parsed.flags.json) {
          console.log(JSON.stringify(history, null, 2));
          break;
        }
        const { task, reviews, events } = history;
        console.log(formatTask(task, true));
        console.log(`  priority ${task.priority ?? 2}${task.reviewRounds ? `, rejected ${task.reviewRounds}x` : ''}${task.result ? `\n  result: ${task.result}` : ''}`);
        for (const r of reviews) console.log(`  review ${r.id} round ${r.reviewRound ?? 1}: ${r.status}${r.claimedBy ? ` by ${r.claimedBy}` : ''}${r.result ? ` - ${r.result}` : ''}`);
        for (const e of events) console.log(`  ${localTime(e.timestamp)} ${e.agentId.padEnd(12)} ${e.type.padEnd(8)} ${e.description}`);
        break;
      }
      if (sub === 'ready') {
        const ready = await service.readyTasks(stringFlag(parsed.flags, 'agent'));
        if (parsed.flags.json) {
          console.log(JSON.stringify(ready, null, 2));
          break;
        }
        if (ready.length === 0) console.log('Nothing ready: every open task is blocked, assigned elsewhere or a review of your own work.');
        for (const task of ready) console.log(`[P${task.priority ?? 2}] ${formatTask(task)}`);
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
        const id = required(stringFlag(parsed.flags, 'id') ?? parsed.positionals[1], '--id');
        // A finished task keeps its verdict; saying "is now FAILED" after `done` read as if it had changed.
        const before = (await service.taskHistory(id)).task;
        if (['DONE', 'FAILED', 'CANCELLED'].includes(before.status)) {
          throw new Error(
            `${id} already ended as ${before.status}; a finished task never changes. ` +
              `To redo or accept the work, create a new task that says "Same as ${id}".`
          );
        }
        const task = await service.finishTask(id, status, stringFlag(parsed.flags, 'message'));
        console.log(`${task.id} is now ${task.status}`);
        break;
      }
      if (sub === 'list') {
        const statusFlag = stringFlag(parsed.flags, 'status');
        const tasks = await service.tasks.list({
          status: statusFlag ? (statusFlag.toUpperCase().split(',') as TaskStatus[]) : undefined,
          agent: stringFlag(parsed.flags, 'agent'),
          archived: parsed.flags.all === true
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
      throw new Error(`Unknown task subcommand: ${sub}. Use create, list, ready, claim, done, fail or cancel.`);
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
      // The claim lease starts when the task is claimed; the timeout starts after the process
      // spawns.
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

      // Loaded per command: a hook runs on every edit and should not pay for the others.
      const { runQueue } = await import('../core/runner.js');
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
      const { assertGitRepo, baselineOf, runWatchPass } = await import('../git/watcher.js');
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

    case 'hub': {
      const { startHub } = await import('../remote/hub.js');
      const hub = await startHub(service, {
        port: numberFlag(parsed.flags, 'port') ?? 4318,
        host: stringFlag(parsed.flags, 'host') ?? '127.0.0.1',
        token: stringFlag(parsed.flags, 'token') ?? process.env.AGENT_MEMORY_TOKEN
      });
      console.log(`Shared memory hub for ${root} at ${hub.url}`);
      console.log(`Token: ${hub.token}`);
      console.log('On each other machine set AGENT_MEMORY_REMOTE to this address and AGENT_MEMORY_TOKEN to the token,');
      console.log('then use agent-memory mcp, setup claude and the CLI as usual.');
      await new Promise(() => undefined);
      break;
    }

    case 'mcp': {
      // stdout belongs to the JSON-RPC transport from here on; never log to it.
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer(service, { agentId: stringFlag(parsed.flags, 'agent') });
      break;
    }

    case 'serve': {
      const port = numberFlag(parsed.flags, 'port') ?? 4317;
      const { startDashboard } = await import('../web/server.js');
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

    case 'reserve': {
      const agentId = required(stringFlag(parsed.flags, 'agent'), '--agent');
      const result = await service.reserve(agentId, pathsFrom(parsed), {
        exclusive: parsed.flags.shared !== true,
        ttlSeconds: (numberFlag(parsed.flags, 'ttl') ?? 30) * 60,
        reason: stringFlag(parsed.flags, 'reason')
      });
      if (parsed.flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.conflicts.length > 0) {
        console.log('Nothing reserved. Held by other agents:');
        for (const c of result.conflicts) {
          console.log(`  ${c.pattern}: ${c.holder.agentId} (${c.holder.pattern}, ${c.holder.exclusive ? 'exclusive' : 'shared'} until ${localTime(c.holder.expiresAt)})`);
        }
      } else {
        for (const r of result.granted) console.log(`Reserved ${r.pattern} for ${r.agentId} (${r.exclusive ? 'exclusive' : 'shared'} until ${localTime(r.expiresAt)})`);
      }
      if (result.conflicts.length > 0) process.exitCode = 1;
      break;
    }

    case 'release': {
      const agentId = required(stringFlag(parsed.flags, 'agent'), '--agent');
      const paths = pathsFrom(parsed, false);
      const released = await service.release(agentId, paths.length ? paths : undefined);
      console.log(`Released ${released} reservation(s).`);
      break;
    }

    case 'reservations': {
      const active = await service.reservations.active();
      if (parsed.flags.json) {
        console.log(JSON.stringify(active, null, 2));
        break;
      }
      if (active.length === 0) console.log('No files reserved.');
      for (const r of active) console.log(`${r.pattern.padEnd(40)} ${r.agentId.padEnd(16)} ${r.exclusive ? 'exclusive' : 'shared   '} until ${localTime(r.expiresAt)}${r.reason ? `  ${r.reason}` : ''}`);
      break;
    }

    case 'remember': {
      const fact = await service.remember(required(parsed.positionals.join(' ') || stringFlag(parsed.flags, 'text'), 'the fact'), stringFlag(parsed.flags, 'agent') ?? 'human');
      console.log(`Remembered ${fact.id}: ${fact.text}`);
      break;
    }

    case 'forget': {
      const removed = await service.forget(required(parsed.positionals[0] ?? stringFlag(parsed.flags, 'id'), 'fact id'));
      console.log(removed ? 'Forgotten.' : 'No single fact matches that id.');
      break;
    }

    case 'facts': {
      const facts = await service.facts.list();
      if (parsed.flags.json) console.log(JSON.stringify(facts, null, 2));
      else if (facts.length === 0) console.log('No project facts yet. Add one with: agent-memory remember "..."');
      else for (const f of facts) console.log(`${f.id}  ${f.text}`);
      break;
    }

    case 'prime': {
      process.stdout.write(await service.prime(stringFlag(parsed.flags, 'agent')));
      break;
    }

    case 'symbols': {
      const file = required(parsed.positionals[0], 'a file');
      const { outlineSymbols } = await import('../core/symbols.js');
      const entries = outlineSymbols(await readFile(path.resolve(root, file), 'utf8'), file);
      if (parsed.flags.json) console.log(JSON.stringify(entries, null, 2));
      else for (const e of entries) console.log(`${String(e.declarationLine).padStart(5)}-${String(e.endLine).padEnd(5)} ${e.kind.padEnd(10)} ${e.container ? `${e.container}.` : ''}${e.name}`);
      break;
    }

    case 'find': {
      const { findSymbol } = await import('../core/symbols.js');
      const matches = await findSymbol(root, required(parsed.positionals[0], 'a symbol name'));
      if (parsed.flags.json) console.log(JSON.stringify(matches, null, 2));
      else if (matches.length === 0) console.log('Not found.');
      else for (const m of matches) console.log(`${m.pointer}  (${m.kind}, lines ${m.declarationLine}-${m.endLine})`);
      break;
    }

    case 'refs': {
      const { findReferences } = await import('../core/symbols.js');
      const refs = await findReferences(root, required(parsed.positionals[0], 'a symbol name'));
      if (parsed.flags.json) console.log(JSON.stringify(refs, null, 2));
      else if (refs.length === 0) console.log('No uses found.');
      else for (const r of refs) console.log(`${r.file}:${r.line}  ${r.text}`);
      break;
    }

    case 'rename': {
      const { renameSymbol } = await import('../core/symbols.js');
      const plan = await renameSymbol(root, required(parsed.positionals[0], 'the symbol'), required(parsed.positionals[1], 'the new name'), {
        apply: parsed.flags.apply === true
      });
      if (parsed.flags.json) {
        console.log(JSON.stringify(plan, null, 2));
        break;
      }
      if (plan.refused) {
        console.log(`Not renamed: ${plan.refused}`);
        process.exitCode = 1;
        break;
      }
      for (const c of plan.changes) console.log(`${c.file}:${c.line}  ${c.after}`);
      console.log(plan.applied ? `Renamed ${plan.from} to ${plan.to} on ${plan.changes.length} line(s).` : `${plan.changes.length} line(s) would change. Run again with --apply to write it.`);
      break;
    }

    case 'hook': {
      const kind = parsed.positionals[0];
      const outcome =
        kind === 'claude'
          ? await runClaudeHook(required(parsed.positionals[1], 'hook event'), await readStdin())
          : kind === 'pre-commit'
            ? await runGitPreCommit(root)
            : undefined;
      if (!outcome) throw new Error('Use: hook claude <session-start|pre-write|post-write|pre-shell|post-shell|session-end>, or hook pre-commit.');
      if (outcome.stdout) process.stdout.write(`${outcome.stdout}\n`);
      if (outcome.stderr) process.stderr.write(`${outcome.stderr}\n`);
      process.exitCode = outcome.exitCode;
      break;
    }

    case 'setup': {
      const target = parsed.positionals[0];
      const options = { remove: parsed.flags.remove === true, hooksOnly: parsed.flags['hooks-only'] === true };
      const done =
        target === 'claude' ? await setupClaude(root, options) : target === 'git' ? await setupGit(root, options) : undefined;
      if (!done) throw new Error('Use: setup claude [--hooks-only] [--remove], or setup git [--remove].');
      for (const line of done) console.log(line);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run agent-memory help.`);
  }
}

/** Paths given as positionals or as a comma-separated --path. */
function pathsFrom(parsed: ReturnType<typeof parseArgs>, needOne = true): string[] {
  const listed = [...parsed.positionals, ...(stringFlag(parsed.flags, 'path')?.split(',') ?? [])].map(p => p.trim()).filter(Boolean);
  if (needOne && listed.length === 0) throw new Error('Name at least one path, e.g. agent-memory reserve --agent A src/auth/');
  return listed;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
                [--priority 0-4]       0 is handed out first; reviews inherit it\n                [--json]               print the task, so a chain can capture its id\n  task list [--status OPEN] [--agent A] [--all] [--json]   --all includes archived tasks\n  task ready [--agent A] [--json]   what can be claimed now, most urgent first\n  task show <id> [--json]           the task, its reviews and every event that names it\n  task claim --agent A\n  task done|fail|cancel --id T-XXX [--message "..."]\n  schedule create --agent A --cron "0 9 * * 1-5" --title "..." [--for B]\n  schedule list [--json]\n  schedule remove --id S-XXX\n  run --agent A --exec "<command>" [--once] [--interval 3] [--timeout 900]\n  scheduler [--interval 30] [--once]\n\nFiles:\n  reserve --agent A <path|folder/|glob>... [--shared] [--ttl 30] [--reason "..."]\n                           all or nothing; other agents are refused while it holds\n  release --agent A [path...]      without paths, everything the agent holds\n  reservations [--json]\n\nCode by symbol:\n  symbols <file> [--json]          what a file declares, with line ranges\n  find <Name|Type.member> [--json] where a symbol is declared in the project\n  refs <Name> [--json]             where it is used\n  rename <Name> <NewName> [--apply] shows every line first; --apply writes it\n\nProject memory:\n  remember "fact" [--agent A]      a fact every session starts with\n  facts [--json]  |  forget <id>\n  prime [--agent A]                the start-of-session briefing\n\nEditors and git:\n  setup claude [--remove]          Claude Code hooks + MCP server for this project\n  setup claude --hooks-only        only the hooks, no MCP server process per session\n  setup git [--remove]             pre-commit guard for reserved files\n  hook claude <session-start|pre-write|post-write|pre-shell|post-shell|session-end>   (run by the hooks)\n  guard-log [--limit 30] [--json] what the shell guard blocked or let through, to learn from\n  hook pre-commit                                                 (run by git)\n\nSeveral machines:\n  hub [--port 4318] [--host 0.0.0.0] [--token T]   share this memory over the network\n  --remote URL --token T   (or AGENT_MEMORY_REMOTE, AGENT_MEMORY_TOKEN) use a hub from any command\n\n  watch [--interval 3] [--once] [--id GIT-WATCHER] [--dry-run]\n  serve [--port 4317]\n  mcp [--agent AGENT-01]   MCP server over stdio (Claude Code, Codex, Cursor...)\n                           --agent fixes the identity and drops it from every tool\n\nGlobal:\n  --root PATH   Project root (defaults to current directory)\n\nPointer examples:\n  src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)\n  src/Orders/OrderService.cs::OrderService.CancelAsync(Guid orderId)::orderId\n`);
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

