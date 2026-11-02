import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { configExists } from '../core/config.js';
import { extractSymbol } from '../core/extract.js';
import { detectConflicts } from '../core/conflicts.js';
import { formatPointer, parsePointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { AgentMemoryService } from '../core/service.js';
import { dependenciesOf } from '../core/tasks.js';
import { editSymbol, findReferences, findSymbol, outlineSymbols, renameSymbol } from '../core/symbols.js';
import { isRemote } from '../remote/client.js';
import { ActivityType, AgentActivity, AgentState, Conflict, ProjectConfig, TaskStatus } from '../models/types.js';
import { INVALID_PARAMS, RpcError } from './jsonrpc.js';

const RECORDABLE: ActivityType[] = [
  'INTENT',
  'READING',
  'FOUND',
  'CHANGED',
  'CREATED',
  'TESTING',
  'WAITING',
  'NOTE',
  'DONE'
];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * When the server is started with --agent, the id is fixed for the whole connection and the `agent`
 * parameter disappears from every schema.
 */
export function buildTools(pinnedAgent?: string): ToolDefinition[] {
  if (!pinnedAgent) return TOOLS;

  return TOOLS.map(tool => {
    // `properties` and `required` are rebuilt, never spread from the original: spreading
    // would carry a stale `required: ["agent"]` through when the filter empties it.
    const { properties: original = {}, required = [], ...rest } = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const properties = { ...original };
    delete properties.agent;
    const stillRequired = required.filter(name => name !== 'agent');

    return {
      ...tool,
      description: tool.description.replace(/Your agent id[^.]*\./g, '').trim(),
      inputSchema: {
        ...rest,
        properties,
        ...(stillRequired.length > 0 ? { required: stillRequired } : {})
      }
    };
  });
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'memory_status',
    description:
      'Read the shared operational memory: which other agents are active, what each is doing right now, and which file/symbol each is touching. ' +
      'Call this before any relevant code action, and again before editing a new area. ' +
      'Pass `pointer` to check a specific file/symbol for overlap before you announce an intent on it.',
    inputSchema: {
      type: 'object',
      properties: {
        pointer: {
          type: 'string',
          description: 'Optional semantic pointer to check for overlap: "file::symbol::parameter".'
        },
        agent: {
          type: 'string',
          description: 'Your own agent id, so you are excluded from the overlap report.'
        }
      }
    }
  },
  {
    name: 'memory_read',
    description:
      'Return the full generated SHARED_MEMORY.md, including every agent block and the recent-activity feed. ' +
      'Use when memory_status is not enough context and you need the whole picture.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'memory_read_pointer',
    description:
      'Read just the code a pointer names, instead of the whole file. Give it "file::symbol" and it returns ' +
      'that symbol with its doc comment and line numbers. Prefer this over opening the file: it is the ' +
      'difference between a few dozen lines and a few hundred. Falls back to reporting that the symbol was ' +
      'not found, in which case read the file normally.',
    inputSchema: {
      type: 'object',
      properties: {
        pointer: {
          type: 'string',
          description: 'A "file::symbol" pointer, e.g. "src/core/config.ts::DEFAULT_CONFIG". A file alone returns the file.'
        }
      },
      required: ['pointer']
    }
  },
  {
    name: 'memory_register',
    description:
      'Register this agent in the shared memory and open its history file. Call once at the start of a session, before any other write. ' +
      'If the id already exists, the existing agent is re-attached instead of failing, so it is safe to call on every reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Stable agent id, e.g. "AGENT-01".' },
        role: { type: 'string', description: 'Role of the agent, e.g. "Backend".' },
        task: { type: 'string', description: 'Demand/ticket the agent is working on, e.g. "AUTH-184".' }
      },
      required: ['agent']
    }
  },
  {
    name: 'memory_record',
    description:
      'Record one step of the READ -> INTENT -> CODE -> RESULT cycle. ' +
      'Use type INTENT before changing code (say exactly what and why), then CHANGED/CREATED/TESTING after the action, ' +
      'FOUND for a relevant discovery, READING while analysing, WAITING when blocked on another agent, NOTE for an operational remark, DONE when the demand is finished. ' +
      'The response reports any other agent working on the same file or symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id, as registered.' },
        type: {
          type: 'string',
          enum: RECORDABLE,
          description: 'Which step of the cycle this record represents.'
        },
        message: {
          type: 'string',
          description: 'Short, precise description of the action or result. Never generic ("improve backend").'
        },
        pointer: {
          type: 'string',
          description:
            'Semantic pointer "file::symbol::parameter", e.g. "src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)". Never use line numbers.'
        },
        reason: { type: 'string', description: 'Why the change is being made. Most useful on INTENT.' },
        task: { type: 'string', description: 'Demand/ticket id, if it changed since registration.' },
        waiting_for: { type: 'string', description: 'Agent id being waited on. Use with type WAITING.' }
      },
      required: ['agent', 'type', 'message']
    }
  },
  {
    name: 'memory_send',
    description:
      'Send a message to another agent inbox. Use it to answer a dependency, hand off work, or warn about a change that affects them. ' +
      'Declaring WAITING through memory_record already notifies the blocking agent, so do not send a duplicate notice for that.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id (the sender).' },
        to: { type: 'string', description: 'Recipient agent id. Must be registered.' },
        message: { type: 'string', description: 'What the recipient needs to know, stated precisely.' },
        pointer: { type: 'string', description: 'Optional "file::symbol::parameter" the message is about.' }
      },
      required: ['agent', 'to', 'message']
    }
  },
  {
    name: 'memory_inbox',
    description:
      'Read messages addressed to this agent. Call it when memory_status reports unread messages, and before continuing blocked work. ' +
      'Reading acknowledges the messages returned, so the next call only shows what arrived since.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        all: { type: 'boolean', description: 'Return the whole inbox instead of only unread messages.' },
        peek: { type: 'boolean', description: 'Read without acknowledging, leaving the messages unread.' }
      },
      required: ['agent']
    }
  },
  {
    name: 'memory_task_create',
    description:
      'Queue work for another agent to pick up later. Unlike a message, a task persists until someone claims and finishes it, ' +
      'so use it for work that must survive this session. Assign it with `for` when a specific agent must do it; leave it open otherwise. ' +
      'To split a demand: queue one task per independent part, then queue the task that puts the parts together with `after` ' +
      'listing all of them; it stays out of the queue until every part has landed.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id (who is asking).' },
        title: { type: 'string', description: 'What needs doing, in one precise line.' },
        detail: { type: 'string', description: 'Everything the executor needs to start without asking.' },
        for: { type: 'string', description: 'Agent id that must do it. Omit to leave it open to anyone.' },
        after: {
          type: 'string',
          description:
            'Comma-separated task ids this one waits for. It is invisible to the queue until every ' +
            'one of them is DONE, so a task that gathers results never runs on partial work.'
        },
        review_by: {
          type: 'string',
          description:
            'Agent that must review the work before it counts as finished. Queues a linked review ' +
            'task that unblocks when the work lands; if the reviewer rejects, the work returns to the queue.'
        },
        reviewers: {
          type: 'integer',
          description:
            'How many agents must judge, 1-9, deciding by majority. This queues an open review panel. One reviewer that ' +
            'reads the right code can still return the wrong verdict, and alone that is the whole ' +
            'decision; a majority absorbs it. Costs a review per agent, so use it where being wrong ' +
            'is expensive, not everywhere.'
        },
        review_open: {
          type: 'boolean',
          description:
            'Queue the review without naming a reviewer: whoever is free takes it, never the agent ' +
            'that did the work. Use instead of review_by when any capable agent can judge, so a busy ' +
            'or dead reviewer cannot leave the work waiting forever.'
        },
        pointer: { type: 'string', description: 'Optional "file::symbol::parameter" the task is about.' },
        priority: {
          type: 'integer',
          description: '0 (most urgent) to 4. Default 2. The queue hands out the most urgent ready task first; its review inherits it.'
        }
      },
      required: ['agent', 'title']
    }
  },
  {
    name: 'memory_task_ready',
    description:
      'List the tasks you could claim right now, most urgent first: nothing blocks them, nobody else holds them, and none ' +
      'is a review of your own work. Use it to choose what to do next.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Your agent id.' } },
      required: ['agent']
    }
  },
  {
    name: 'memory_task_list',
    description: 'List queued work. Call it when looking for something to pick up, or to check on work you delegated.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Comma-separated filter: OPEN, CLAIMED, DONE, FAILED, CANCELLED. Defaults to all.'
        },
        with_results: {
          type: 'boolean',
          description:
            'Include what each finished task reported. Off by default because results are long; ' +
            'turn it on to read back work you delegated.'
        }
      }
    }
  },
  {
    name: 'memory_task_claim',
    description:
      'Take the oldest task available to you and start working on it. The claim is exclusive, and expires if you stop ' +
      'without finishing, so the work returns to the queue rather than being lost.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Your agent id.' } },
      required: ['agent']
    }
  },
  {
    name: 'memory_task_finish',
    description:
      'Close a task you claimed. Report the outcome honestly: use FAILED with the reason when it did not work, ' +
      'rather than DONE. Whoever queued it is told either way.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id, e.g. T-ABC123.' },
        status: { type: 'string', enum: ['DONE', 'FAILED', 'CANCELLED'], description: 'How it ended.' },
        result: { type: 'string', description: 'What happened, briefly.' }
      },
      required: ['id', 'status']
    }
  },
  {
    name: 'memory_heartbeat',
    description:
      'Refresh this agent presence so it does not appear OFFLINE to the others. ' +
      'Call during long stretches of work where nothing else is being recorded.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Your agent id.' } },
      required: ['agent']
    }
  },
  {
    name: 'memory_log',
    description:
      'Return the most recent entries of the global event journal, newest first, across all agents. ' +
      'Use to understand what happened while this agent was not looking.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many events to return (default 20, max 200).' },
        agent: { type: 'string', description: 'Only return events from this agent id.' }
      }
    }
  },
  {
    name: 'memory_reserve',
    description:
      'Reserve files, folders ("src/auth/") or globs ("src/**/*.test.ts") before changing them. Exclusive by default: other ' +
      'agents are refused while it holds, at write time and at commit. All or nothing: if any path is held by someone ' +
      'else, nothing is reserved and you are told by whom. Reservations expire on their own.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths, folders or globs.' },
        shared: { type: 'boolean', description: 'Allow other shared holders (readers); only an exclusive claim is refused.' },
        minutes: { type: 'integer', description: 'How long to hold them, default 30. Reserve again to extend.' },
        reason: { type: 'string', description: 'What for, shown to the agents you keep out.' }
      },
      required: ['agent', 'paths']
    }
  },
  {
    name: 'memory_release',
    description: 'Release reservations you hold, so other agents can change those files. Without paths, releases all of yours.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'The patterns to release, as reserved.' }
      },
      required: ['agent']
    }
  },
  {
    name: 'memory_reservations',
    description: 'List the files reserved right now: by whom, exclusive or shared, and until when.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'memory_symbols',
    description:
      'List what a file declares (types, functions, methods, properties, constants) with line ranges, without reading it. ' +
      'Use it to pick the one symbol to read with memory_read_pointer.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Project-relative file path.' } },
      required: ['file']
    }
  },
  {
    name: 'memory_find_symbol',
    description: 'Find where a symbol is declared anywhere in the project. "Type.member" narrows to that type. Returns pointers.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A name, e.g. "CancelAsync" or "OrderService.CancelAsync".' } },
      required: ['name']
    }
  },
  {
    name: 'memory_references',
    description: 'Find the lines that use a symbol across the project, outside strings and comments. Use before changing its signature.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The symbol name.' } },
      required: ['name']
    }
  },
  {
    name: 'memory_replace_symbol',
    description:
      'Replace one function, method, class or property in place, instead of rewriting the whole file. The file is re-read at ' +
      'the moment of the edit, so changes other agents made elsewhere in it survive, and the change is recorded for them. ' +
      'Give the complete new code of the symbol, from its signature to its end. Include a doc comment only to replace the old one.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        pointer: { type: 'string', description: '"file::symbol" or "file::Type.member".' },
        code: { type: 'string', description: 'The new code of the symbol.' }
      },
      required: ['agent', 'pointer', 'code']
    }
  },
  {
    name: 'memory_insert_symbol',
    description: 'Insert new code right after (or before) an existing symbol, e.g. a new method after another. Same safety as memory_replace_symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        pointer: { type: 'string', description: 'The existing symbol to insert next to: "file::symbol".' },
        code: { type: 'string', description: 'The new code.' },
        before: { type: 'boolean', description: 'Insert before the symbol instead of after it.' }
      },
      required: ['agent', 'pointer', 'code']
    }
  },
  {
    name: 'memory_rename',
    description:
      'Rename a symbol everywhere it is used. Without apply it only shows every line that would change; read that, then call ' +
      'again with apply=true. Refused when the name is declared more than once in the project, since its uses cannot be told apart.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        symbol: { type: 'string', description: 'The current name, e.g. "calcTotal" or "Order.calcTotal".' },
        new_name: { type: 'string', description: 'The new name.' },
        apply: { type: 'boolean', description: 'Write the change. Leave out to see the plan first.' }
      },
      required: ['agent', 'symbol', 'new_name']
    }
  },
  {
    name: 'memory_task_show',
    description: 'Everything about one task: its details, who claimed it, every review and verdict, and each journal entry that names it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id, e.g. T-ABC123.' } },
      required: ['id']
    }
  },
  {
    name: 'memory_remember',
    description:
      'Store a fact about the project that every agent should start with ("tests need Postgres running"). Keep it short and ' +
      'lasting; per-task notes belong in memory_record.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent id.' },
        fact: { type: 'string', description: 'The fact, under 500 characters.' }
      },
      required: ['agent', 'fact']
    }
  },
  {
    name: 'memory_prime',
    description:
      'The start-of-session briefing: how to work here, project facts, who is active, which files are reserved, what work is ' +
      'ready and whether messages wait for you. Call it first in a session.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Your agent id.' } }
    }
  }
];

export async function callTool(
  service: AgentMemoryService,
  name: string,
  args: Record<string, unknown>,
  pinnedAgent?: string
): Promise<string> {
  if (!isRemote(service) && !(await configExists(service.root))) {
    throw new Error(
      `No .agents/ found in ${service.root}. Run "agent-memory init" in the project root, or start the server with --root PATH.`
    );
  }

  // A pinned id always wins: the connection owns the identity, not the caller.
  const agentId = (): string => {
    if (pinnedAgent) return pinnedAgent;
    return requiredString(args, 'agent');
  };

  switch (name) {
    case 'memory_status':
      return statusText(service, optionalString(args, 'pointer'), pinnedAgent ?? optionalString(args, 'agent'));
    case 'memory_read':
      return service.store.readSharedMemory();
    case 'memory_read_pointer':
      return readPointerText(service, requiredString(args, 'pointer'));
    case 'memory_register':
      return registerText(service, agentId(), optionalString(args, 'role'), optionalString(args, 'task'));
    case 'memory_record':
      return recordText(service, agentId(), args);
    case 'memory_send': {
      const message = await service.sendMessage({
        from: agentId(),
        to: requiredString(args, 'to'),
        body: requiredString(args, 'message'),
        pointer: parsePointer(optionalString(args, 'pointer'))
      });
      return `Delivered to ${message.to}.`;
    }
    case 'memory_inbox':
      return inboxText(service, agentId(), args);
    case 'memory_task_create': {
      const task = await service.createTask({
        title: requiredString(args, 'title'),
        createdBy: agentId(),
        detail: optionalString(args, 'detail'),
        assignedTo: optionalString(args, 'for'),
        pointer: parsePointer(optionalString(args, 'pointer')),
        reviewBy: optionalString(args, 'review_by'),
        reviewOpen: (args as Record<string, unknown> | null)?.review_open === true,
        reviewers: optionalNumber(args, 'reviewers'),
        priority: optionalNumber(args, 'priority'),
        dependsOn: optionalString(args, 'after')
          ?.split(',')
          .map(id => id.trim())
          .filter(Boolean),
        // Set by the runner, so tasks created here count one generation deeper.
        parentTaskId: process.env.AGENT_TASK_ID || undefined
      });
      const review = task.reviewTaskId ? ` Review queued as ${task.reviewTaskId}.` : '';
      // Say explicitly that a task queued with `after` waits for its dependencies.
      const waiting = dependenciesOf(task);
      const blocked = waiting.length ? ` Waiting for ${waiting.join(', ')}.` : '';
      return `Queued ${task.id}: ${task.title}${task.assignedTo ? ` (for ${task.assignedTo})` : ''} at depth ${task.depth}.${blocked}${review}`;
    }
    case 'memory_task_list': {
      const statusFilter = optionalString(args, 'status');
      const tasks = await service.tasks.list({
        status: statusFilter ? (statusFilter.toUpperCase().split(',') as TaskStatus[]) : undefined
      });
      if (tasks.length === 0) return 'No tasks.';
      const withResults = args !== null && typeof args === 'object' && (args as Record<string, unknown>).with_results === true;
      return tasks
        .map(task => {
          const who = task.assignedTo ? ` for ${task.assignedTo}` : task.claimedBy ? ` by ${task.claimedBy}` : '';
          const where = task.pointer ? ` | ${formatPointer(task.pointer)}` : '';
          const head = `${task.id} ${task.status} ${task.title}${who}${where}`;
          return withResults && task.result ? `${head}\n    -> ${task.result.replace(/\n/g, '\n       ')}` : head;
        })
        .join('\n');
    }
    case 'memory_task_claim': {
      const task = await service.claimTask(agentId());
      if (!task) return 'No task available to claim.';
      const lines = [`Claimed ${task.id}: ${task.title}`];
      if (task.detail) lines.push(task.detail);
      if (task.pointer) lines.push(`Pointer: ${formatPointer(task.pointer)}`);

      // Include the results of the tasks this one waited for, only for the agent that claims it.
      const waited = dependenciesOf(task);
      if (waited.length > 0) {
        lines.push('', 'Results of the parts this task waited for:');
        for (const id of waited) {
          const part = await service.tasks.read(id).catch(() => undefined);
          if (!part) continue;
          lines.push(`- ${part.id} (${part.title}) by ${part.claimedBy ?? 'unknown'}: ${part.result ?? '(no result recorded)'}`);
        }
      }

      lines.push(`Queued by ${task.createdBy}. Call memory_task_finish when done.`);
      return lines.join('\n');
    }
    case 'memory_task_finish': {
      const status = requiredString(args, 'status').toUpperCase() as TaskStatus;
      if (!['DONE', 'FAILED', 'CANCELLED'].includes(status)) {
        throw new RpcError(INVALID_PARAMS, `Invalid status: ${status}. Use DONE, FAILED or CANCELLED.`);
      }
      const task = await service.finishTask(requiredString(args, 'id'), status, optionalString(args, 'result'));
      return `${task.id} is now ${task.status}.`;
    }
    case 'memory_heartbeat': {
      const state = await service.heartbeat(agentId());
      return `Heartbeat recorded for ${state.id} at ${state.lastHeartbeatAt}.`;
    }
    case 'memory_log':
      return logText(service, args);
    case 'memory_task_ready': {
      const ready = await service.readyTasks(agentId());
      if (ready.length === 0) return 'Nothing ready for you: every open task is blocked, assigned elsewhere or a review of your own work.';
      return ready.map(t => `${t.id} [P${t.priority ?? 2}] ${t.title}${t.pointer ? ` (${formatPointer(t.pointer)})` : ''}`).join('\n');
    }
    case 'memory_reserve': {
      const result = await service.reserve(agentId(), stringList(args, 'paths'), {
        exclusive: args.shared !== true,
        ttlSeconds: (optionalNumber(args, 'minutes') ?? 30) * 60,
        reason: optionalString(args, 'reason')
      });
      if (result.conflicts.length > 0) {
        return [
          'Nothing reserved. Held by other agents:',
          ...result.conflicts.map(c => `- ${c.pattern}: ${c.holder.agentId} holds ${c.holder.pattern} (${c.holder.exclusive ? 'exclusive' : 'shared'}) until ${c.holder.expiresAt}${c.holder.reason ? `: ${c.holder.reason}` : ''}`),
          'Pick other work, or ask them with memory_send.'
        ].join('\n');
      }
      return `Reserved ${result.granted.map(r => r.pattern).join(', ')} until ${result.granted[0].expiresAt}. Release with memory_release when done.`;
    }
    case 'memory_release': {
      const paths = Array.isArray(args.paths) ? stringList(args, 'paths') : undefined;
      return `Released ${await service.release(agentId(), paths)} reservation(s).`;
    }
    case 'memory_reservations': {
      const active = await service.reservations.active();
      if (active.length === 0) return 'No files reserved.';
      return active.map(r => `${r.pattern}: ${r.agentId}, ${r.exclusive ? 'exclusive' : 'shared'} until ${r.expiresAt}${r.reason ? ` (${r.reason})` : ''}`).join('\n');
    }
    case 'memory_symbols': {
      const file = requiredString(args, 'file');
      const target = insideRoot(service.root, file);
      const entries = outlineSymbols(await readFile(target, 'utf8'), file);
      if (entries.length === 0) return `No declarations recognised in ${file}. Read it with memory_read_pointer "${file}".`;
      return entries.map(e => `${e.declarationLine}-${e.endLine} ${e.kind} ${e.container ? `${e.container}.` : ''}${e.name}`).join('\n');
    }
    case 'memory_find_symbol': {
      const matches = await findSymbol(service.root, requiredString(args, 'name'));
      if (matches.length === 0) return 'Not found. Try memory_references, or a shorter name.';
      return matches.map(m => `${m.pointer} (${m.kind}, lines ${m.declarationLine}-${m.endLine})`).join('\n');
    }
    case 'memory_references': {
      const refs = await findReferences(service.root, requiredString(args, 'name'));
      if (refs.length === 0) return 'No uses found outside its declaration.';
      return refs.map(r => `${r.file}:${r.line}  ${r.text}`).join('\n');
    }
    case 'memory_replace_symbol':
    case 'memory_insert_symbol': {
      const agent = agentId();
      const pointer = requiredString(args, 'pointer');
      const file = pointer.split('::')[0];
      // Edits by symbol respect reservations too.
      const holders = (await service.reservations.holders(file, agent)).filter(r => r.exclusive);
      if (holders.length > 0) {
        return `Not changed: ${file} is reserved by ${holders[0].agentId} until ${holders[0].expiresAt}. Pick other work, or ask them with memory_send.`;
      }
      const mode = name === 'memory_replace_symbol' ? 'replace' : args.before === true ? 'insert_before' : 'insert_after';
      const result = await editSymbol(service.root, pointer, requiredString(args, 'code'), mode);
      if (await service.store.stateExists(agent)) {
        await service.activity({
          agentId: agent,
          type: 'CHANGED',
          description: `${mode === 'replace' ? 'replaced' : 'inserted next to'} ${result.symbol}`,
          pointer: { file: result.file, symbol: result.symbol }
        });
      }
      return `${mode === 'replace' ? 'Replaced' : 'Inserted'} at ${result.file} lines ${result.fromLine}-${result.toLine}${result.removedLines ? ` (was ${result.removedLines} lines)` : ''}.`;
    }
    case 'memory_remember': {
      const fact = await service.remember(requiredString(args, 'fact'), agentId());
      return `Remembered (${fact.id}). Every session now starts with it.`;
    }
    case 'memory_rename': {
      const agent = agentId();
      const plan = await renameSymbol(service.root, requiredString(args, 'symbol'), requiredString(args, 'new_name'));
      if (plan.refused) return `Not renamed: ${plan.refused}`;
      const files = [...new Set(plan.changes.map(c => c.file))];
      for (const file of files) {
        const held = (await service.reservations.holders(file, agent)).filter(r => r.exclusive);
        if (held.length) return `Not renamed: ${file} is reserved by ${held[0].agentId} until ${held[0].expiresAt}.`;
      }
      const listing = plan.changes.slice(0, 60).map(c => `${c.file}:${c.line}  ${c.after}`).join('\n');
      if (args.apply !== true) {
        return `Plan: ${plan.changes.length} line(s) in ${files.length} file(s) would change. Call again with apply=true to write it.\n${listing}`;
      }
      const done = await renameSymbol(service.root, requiredString(args, 'symbol'), requiredString(args, 'new_name'), { apply: true });
      if (await service.store.stateExists(agent)) {
        for (const file of files) {
          await service.activity({ agentId: agent, type: 'CHANGED', description: `renamed ${done.from} to ${done.to}`, pointer: { file } });
        }
      }
      return `Renamed ${done.from} to ${done.to}: ${done.changes.length} line(s) in ${files.length} file(s).\n${listing}`;
    }
    case 'memory_task_show': {
      const { task, reviews, events } = await service.taskHistory(requiredString(args, 'id'));
      return [
        `${task.id} ${task.status} [P${task.priority ?? 2}] ${task.title}`,
        task.detail ? `Detail: ${task.detail}` : '',
        `Created by ${task.createdBy}${task.claimedBy ? `, claimed by ${task.claimedBy}` : ''}; attempts ${task.attempts}${task.reviewRounds ? `, rejected ${task.reviewRounds}x` : ''}`,
        task.result ? `Result: ${task.result}` : '',
        ...reviews.map(r => `Review ${r.id} (round ${r.reviewRound ?? 1}): ${r.status}${r.claimedBy ? ` by ${r.claimedBy}` : ''}${r.result ? `: ${r.result}` : ''}`),
        '',
        ...events.map(e => `${e.timestamp} ${e.agentId} ${e.type} ${e.description}`)
      ]
        .filter((line, i) => line !== '' || i > 3)
        .join('\n');
    }
    case 'memory_prime':
      return service.prime(pinnedAgent ?? optionalString(args, 'agent'));
    default:
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

async function statusText(service: AgentMemoryService, pointer?: string, requester?: string): Promise<string> {
  const config = await service.config();
  const states = (await service.states()).sort((a, b) => a.id.localeCompare(b.id));
  const unread = await Promise.all(states.map(state => service.messages.unreadCount(state.id)));
  const lines = [`Project: ${config.projectName}`, ''];

  if (states.length === 0) {
    lines.push('No agents registered yet.');
  } else {
    states.forEach((state, index) => lines.push(...agentBlock(state, config, unread[index])));
  }

  if (requester) {
    const mine = unread[states.findIndex(state => state.id === requester)] ?? 0;
    if (mine > 0) {
      lines.push(`You have ${mine} unread message(s). Call memory_inbox before continuing.`, '');
    }
  }

  const parsed = parsePointer(pointer);
  if (parsed) {
    lines.push('', `Overlap check for ${formatPointer(parsed)}:`);
    const conflicts = detectConflicts(states, requester ?? '', parsed);
    lines.push(...conflictLines(conflicts, 'No active agent is working on that pointer.'));
  }

  return lines.join('\n');
}

async function registerText(
  service: AgentMemoryService,
  agentId: string,
  role?: string,
  task?: string
): Promise<string> {
  if (await service.store.stateExists(agentId)) {
    // Re-attach instead of failing: an agent that restarts its session must not be blocked.
    const state = await service.heartbeat(agentId);
    return [
      `${agentId} was already registered; re-attached to the existing session ${state.sessionId}.`,
      `Demand: ${state.task ?? '-'}`,
      `Last recorded action: ${state.current?.description ?? '-'}`,
      '',
      'History is preserved. Record a new INTENT before changing code.'
    ].join('\n');
  }

  const state = await service.register(agentId, role, task);
  return `Registered ${state.id} (session ${state.sessionId}). History: .agents/history/${state.id}.md`;
}

async function recordText(
  service: AgentMemoryService,
  agentId: string,
  args: Record<string, unknown>
): Promise<string> {
  const type = requiredString(args, 'type').toUpperCase() as ActivityType;
  if (!RECORDABLE.includes(type)) {
    throw new RpcError(INVALID_PARAMS, `Invalid type: ${type}. Expected one of ${RECORDABLE.join(', ')}.`);
  }

  const pointer = parsePointer(optionalString(args, 'pointer'));
  const result = await service.activity({
    agentId,
    type,
    description: requiredString(args, 'message'),
    pointer,
    task: optionalString(args, 'task'),
    reason: optionalString(args, 'reason'),
    waitingFor: optionalString(args, 'waiting_for')
  });

  const lines = [`${type} recorded for ${agentId}. Status is now ${result.state.status}.`];
  if (pointer) lines.push(`Pointer: ${formatPointer(pointer)}`);
  if (result.conflicts.length > 0) {
    lines.push('', `WARNING: ${result.conflicts.length} active overlap(s) detected.`);
    lines.push(...conflictLines(result.conflicts, ''));
    lines.push(
      '',
      'Do not undo their work. Adjust your change to coexist, or record a WAITING entry naming the agent you depend on.'
    );
  }
  // Report unread messages here: recording is the call agents make before writing.
  const unread = await service.messages.unreadCount(agentId);
  if (unread > 0) lines.push('', `You have ${unread} unread message(s). Call memory_inbox before writing.`);
  return lines.join('\n');
}

async function logText(service: AgentMemoryService, args: Record<string, unknown>): Promise<string> {
  const requested = optionalNumber(args, 'limit') ?? 20;
  const limit = Math.min(200, Math.max(1, requested));
  const agentId = optionalString(args, 'agent');
  // Over-fetch so an agent filter can still fill the requested window.
  const activities = await service.store.recentActivities(agentId ? limit * 10 : limit);
  const filtered = (agentId ? activities.filter(a => a.agentId === agentId) : activities).slice(0, limit);

  if (filtered.length === 0) return 'No events recorded yet.';
  return filtered.map(eventLine).join('\n');
}

function agentBlock(state: AgentState, config: ProjectConfig, unread = 0): string[] {
  const lines = [
    `${state.id} | ${effectiveStatus(state, config)}${state.role ? ` | ${state.role}` : ''}`,
    `  Demand: ${state.task ?? '-'}`,
    `  Now: ${state.current?.description ?? 'No current action.'}`,
    `  Pointer: ${formatPointer(state.current?.pointer)}`
  ];
  if (state.current?.waitingFor) lines.push(`  Waiting for: ${state.current.waitingFor}`);
  if (unread > 0) lines.push(`  Unread messages: ${unread}`);
  lines.push(`  Updated: ${state.updatedAt}`);
  return lines;
}

const MAX_POINTER_READ_BYTES = 200_000;

/** Returns the source a pointer names, narrowed to the symbol when there is one. */
async function readPointerText(service: AgentMemoryService, raw: string): Promise<string> {
  const pointer = parsePointer(raw);
  if (!pointer?.file) {
    throw new Error(`Not a pointer: ${JSON.stringify(raw)}. Use "file::symbol".`);
  }

  const root = path.resolve(service.root);
  const target = path.resolve(root, pointer.file);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Outside the project: ${pointer.file}`);
  }

  let source: string;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_POINTER_READ_BYTES) {
      // Without a symbol, cap the size of the file returned.
      if (!pointer.symbol) {
        throw new Error(`${pointer.file} is ${Math.round(info.size / 1024)}kB. Point at a symbol to read part of it.`);
      }
    }
    source = await readFile(target, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${pointer.file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!pointer.symbol) return `${pointer.file} (whole file)\n\n${source}`;

  const found = extractSymbol(source, pointer.symbol);
  if (!found) {
    return (
      `Symbol ${JSON.stringify(pointer.symbol)} was not found in ${pointer.file}. ` +
      'Read the file to check the spelling.'
    );
  }
  return `${pointer.file}:${found.startLine}-${found.endLine} (${pointer.symbol})\n\n${found.text}`;
}

async function inboxText(
  service: AgentMemoryService,
  agentId: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await service.readInbox(agentId, { markRead: args.peek !== true });
  const shown = args.all === true ? result.messages : result.unread;

  if (shown.length === 0) {
    return args.all === true ? 'Inbox is empty.' : 'No unread messages.';
  }

  const lines: string[] = [];
  for (const message of shown) {
    const tag = message.kind === 'waiting' ? ' [dependency]' : message.kind === 'overlap' ? ' [same file]' : '';
    lines.push(`${message.timestamp} | from ${message.from}${tag}`);
    lines.push(`  ${message.body}`);
    if (message.pointer) lines.push(`  ${formatPointer(message.pointer)}`);
  }
  lines.push('', `${shown.length} message(s)${args.all === true ? '' : ' unread'}.`);
  return lines.join('\n');
}

function conflictLines(conflicts: Conflict[], emptyMessage: string): string[] {
  if (conflicts.length === 0) return emptyMessage ? [emptyMessage] : [];
  return conflicts.map(
    c => `- ${c.agentId} [${c.status}] ${c.exact ? 'EXACT' : 'RELATED'} ${formatPointer(c.pointer)} :: ${c.description}`
  );
}

function eventLine(activity: AgentActivity): string {
  const pointer = activity.pointer ? ` | ${formatPointer(activity.pointer)}` : '';
  return `${activity.timestamp} | ${activity.agentId} | ${activity.type} | ${activity.description}${pointer}`;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError(INVALID_PARAMS, `Missing required string argument: ${key}`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim();
}

function stringList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const clean = list.map(v => String(v).trim()).filter(Boolean);
  if (clean.length === 0) throw new RpcError(INVALID_PARAMS, `Missing ${key}: give at least one path.`);
  return clean;
}

/** A project-relative path resolved under the root; a path that escapes it is refused. */
function insideRoot(root: string, file: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, file);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new RpcError(INVALID_PARAMS, `Outside the project: ${file}`);
  return target;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
