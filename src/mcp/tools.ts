import { configExists } from '../core/config.js';
import { detectConflicts } from '../core/conflicts.js';
import { formatPointer, parsePointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { AgentMemoryService } from '../core/service.js';
import { ActivityType, AgentActivity, AgentState, Conflict, ProjectConfig } from '../models/types.js';
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
  }
];

export async function callTool(
  service: AgentMemoryService,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!(await configExists(service.root))) {
    throw new Error(
      `No .agents/ found in ${service.root}. Run "agent-memory init" in the project root, or start the server with --root PATH.`
    );
  }

  switch (name) {
    case 'memory_status':
      return statusText(service, optionalString(args, 'pointer'), optionalString(args, 'agent'));
    case 'memory_read':
      return service.store.readSharedMemory();
    case 'memory_register':
      return registerText(service, requiredString(args, 'agent'), optionalString(args, 'role'), optionalString(args, 'task'));
    case 'memory_record':
      return recordText(service, args);
    case 'memory_send': {
      const message = await service.sendMessage({
        from: requiredString(args, 'agent'),
        to: requiredString(args, 'to'),
        body: requiredString(args, 'message'),
        pointer: parsePointer(optionalString(args, 'pointer'))
      });
      return `Delivered to ${message.to}.`;
    }
    case 'memory_inbox':
      return inboxText(service, args);
    case 'memory_heartbeat': {
      const state = await service.heartbeat(requiredString(args, 'agent'));
      return `Heartbeat recorded for ${state.id} at ${state.lastHeartbeatAt}.`;
    }
    case 'memory_log':
      return logText(service, args);
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

async function recordText(service: AgentMemoryService, args: Record<string, unknown>): Promise<string> {
  const agentId = requiredString(args, 'agent');
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

async function inboxText(service: AgentMemoryService, args: Record<string, unknown>): Promise<string> {
  const agentId = requiredString(args, 'agent');
  const result = await service.readInbox(agentId, { markRead: args.peek !== true });
  const shown = args.all === true ? result.messages : result.unread;

  if (shown.length === 0) {
    return args.all === true ? 'Inbox is empty.' : 'No unread messages.';
  }

  const lines: string[] = [];
  for (const message of shown) {
    const tag = message.kind === 'waiting' ? ' [dependency]' : '';
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

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}
