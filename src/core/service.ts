import { AgentActivity, AgentMessage, AgentState, AgentStatus, ActivityType, CodePointer, Conflict, ProjectConfig } from '../models/types.js';
import { createId, createSessionId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import { readConfig, writeConfig, DEFAULT_CONFIG } from './config.js';
import { detectConflicts } from './conflicts.js';
import { InboxStore } from './inbox.js';
import { formatPointer, pointerKey } from './pointer.js';
import { MemoryStore } from './store.js';

export interface ActivityInput {
  agentId: string;
  type: ActivityType;
  description: string;
  task?: string;
  pointer?: CodePointer;
  reason?: string;
  waitingFor?: string;
  status?: AgentStatus;
}

export interface ActivityResult {
  activity: AgentActivity;
  state: AgentState;
  conflicts: Conflict[];
}

export interface CompactOptions {
  keep?: number;
  history?: boolean;
  dryRun?: boolean;
}

export interface CompactResult {
  eventsTotal: number;
  eventsArchived: number;
  eventsArchiveFile?: string;
  historyArchived: Array<{ agent: string; file: string }>;
  messagesTrimmed: Array<{ agent: string; removed: number }>;
  dryRun: boolean;
}

export interface SendMessageInput {
  from: string;
  to: string;
  body: string;
  pointer?: CodePointer;
  kind?: AgentMessage['kind'];
}

export interface InboxResult {
  messages: AgentMessage[];
  unread: AgentMessage[];
}

export class AgentMemoryService {
  readonly store: MemoryStore;
  readonly messages: InboxStore;

  constructor(public readonly root = process.cwd()) {
    this.store = new MemoryStore(root);
    this.messages = new InboxStore(root);
  }

  async init(projectName?: string, overrides: Partial<ProjectConfig> = {}): Promise<ProjectConfig> {
    const config: ProjectConfig = {
      ...DEFAULT_CONFIG,
      ...overrides,
      projectName: projectName || overrides.projectName || DEFAULT_CONFIG.projectName
    };
    await this.store.initialize(config);
    return config;
  }

  async config(): Promise<ProjectConfig> {
    return readConfig(this.root);
  }

  async updateConfig(patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const current = await this.config();
    const next = { ...current, ...patch, version: 1 as const };
    await writeConfig(next, this.root);
    await this.store.refreshSharedMemory(next);
    return next;
  }

  async register(agentId: string, role?: string, task?: string): Promise<AgentState> {
    if (await this.store.stateExists(agentId)) {
      throw new Error(
        `Agent already exists: ${agentId}. Use --force to start a new session, or unregister it first.`
      );
    }
    const now = nowIso();
    const registeredDescription = task ? `Registered and ready for ${task}.` : 'Registered and ready.';
    const state: AgentState = {
      id: agentId,
      role,
      sessionId: createSessionId(),
      status: 'ONLINE',
      task,
      current: {
        type: 'REGISTERED',
        description: registeredDescription
      },
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    await this.store.writeState(state);
    await this.store.openHistory(state);
    const activity = this.makeActivity({
      agentId,
      type: 'REGISTERED',
      description: registeredDescription,
      task
    });
    await this.store.appendActivity(activity);
    await this.store.refreshSharedMemory(await this.config());
    return state;
  }

  /**
   * Starts a fresh session for an agent that already exists, keeping its history.
   * This is the recovery path for an agent whose process restarted.
   */
  async reset(agentId: string, role?: string, task?: string): Promise<AgentState> {
    const previous = await this.requireAgent(agentId);
    const now = nowIso();
    const nextTask = task ?? previous.task;
    const description = nextTask ? `Session restarted for ${nextTask}.` : 'Session restarted.';
    const state: AgentState = {
      id: agentId,
      role: role ?? previous.role,
      sessionId: createSessionId(),
      status: 'ONLINE',
      task: nextTask,
      current: { type: 'REGISTERED', description },
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    await this.store.writeState(state);
    await this.store.openHistory(state);
    await this.store.appendActivity(
      this.makeActivity({ agentId, type: 'REGISTERED', description, task: nextTask }, now)
    );
    await this.store.refreshSharedMemory(await this.config());
    return state;
  }

  /** Removes an agent from the shared panel. Its history file is kept as the audit trail. */
  async unregister(agentId: string): Promise<AgentState> {
    const state = await this.requireAgent(agentId);
    await this.store.appendActivity(
      this.makeActivity({
        agentId,
        type: 'UNREGISTERED',
        description: 'Removed from the shared panel; history preserved.',
        task: state.task
      })
    );
    await this.store.deleteState(agentId);
    await this.store.refreshSharedMemory(await this.config());
    return state;
  }

  async compact(options: CompactOptions = {}): Promise<CompactResult> {
    const keep = Math.max(0, options.keep ?? 500);
    const dryRun = options.dryRun === true;
    const stamp = nowIso().replace(/[:.]/g, '-');
    const eventsTotal = await this.store.countEvents();

    const result: CompactResult = {
      eventsTotal,
      eventsArchived: 0,
      historyArchived: [],
      messagesTrimmed: [],
      dryRun
    };

    if (dryRun) {
      result.eventsArchived = Math.max(0, eventsTotal - keep);
      if (options.history) {
        result.historyArchived = (await this.store.listHistoryAgents()).map(agent => ({ agent, file: '(dry run)' }));
      }
      for (const agent of await this.messages.listInboxes()) {
        const total = (await this.messages.list(agent)).length;
        if (total > keep) result.messagesTrimmed.push({ agent, removed: total - keep });
      }
      return result;
    }

    const archived = await this.store.archiveEvents(keep, stamp);
    if (archived) {
      result.eventsArchived = archived.archived;
      result.eventsArchiveFile = archived.file;
    }

    if (options.history) {
      for (const agent of await this.store.listHistoryAgents()) {
        const file = await this.store.archiveHistory(agent, stamp);
        if (file) result.historyArchived.push({ agent, file });
      }
    }

    // Inboxes grow with every message; only already-read ones are safe to drop.
    for (const agent of await this.messages.listInboxes()) {
      const removed = await this.messages.trim(agent, keep);
      if (removed > 0) result.messagesTrimmed.push({ agent, removed });
    }

    await this.store.refreshSharedMemory(await this.config());
    return result;
  }

  async heartbeat(agentId: string): Promise<AgentState> {
    const state = await this.requireAgent(agentId);
    const now = nowIso();
    const next: AgentState = { ...state, lastHeartbeatAt: now, updatedAt: now };
    await this.store.writeState(next);
    await this.store.refreshSharedMemory(await this.config());
    return next;
  }

  async activity(input: ActivityInput): Promise<ActivityResult> {
    const state = await this.requireAgent(input.agentId);
    const states = await this.store.listStates();
    const conflicts = detectConflicts(states, input.agentId, input.pointer);
    const now = nowIso();
    const activity = this.makeActivity({ ...input, task: input.task ?? state.task }, now);
    const status = input.status ?? statusFor(input.type, state.status);
    const next: AgentState = {
      ...state,
      status,
      task: input.task ?? state.task,
      current: {
        type: input.type,
        description: input.description,
        pointer: input.pointer,
        reason: input.reason,
        waitingFor: input.waitingFor
      },
      updatedAt: now,
      lastHeartbeatAt: now
    };

    await this.store.writeState(next);
    await this.store.appendActivity(activity);
    await this.notifyDependency(input, state);
    await this.store.refreshSharedMemory(await this.config());
    return { activity, state: next, conflicts };
  }

  /**
   * Declaring a dependency should reach the agent being depended on. Without this the
   * wait is only visible to whoever happens to read the panel.
   */
  private async notifyDependency(input: ActivityInput, previous: AgentState): Promise<void> {
    if (input.type !== 'WAITING' || !input.waitingFor) return;
    if (input.waitingFor === input.agentId) return;

    // Re-declaring the same wait must not send the same notice again.
    const repeated =
      previous.status === 'WAITING' &&
      previous.current?.waitingFor === input.waitingFor &&
      pointerKey(previous.current?.pointer) === pointerKey(input.pointer);
    if (repeated) return;

    // A wait on someone who never registered is still a valid record, just undeliverable.
    if (!(await this.store.stateExists(input.waitingFor))) return;

    const where = input.pointer ? ` on ${formatPointer(input.pointer)}` : '';
    await this.deliver({
      from: input.agentId,
      to: input.waitingFor,
      body: `${input.agentId} is waiting for you${where}: ${input.description}`,
      pointer: input.pointer,
      kind: 'waiting'
    });
  }

  /** Sends a message to another agent inbox. The recipient must be registered. */
  async sendMessage(input: SendMessageInput): Promise<AgentMessage> {
    const message = await this.deliver(input);
    await this.store.refreshSharedMemory(await this.config());
    return message;
  }

  /**
   * Reads an agent inbox. By default this acknowledges everything returned, so the next
   * read only surfaces what arrived since. Pass `markRead: false` to peek.
   */
  async readInbox(agentId: string, options: { markRead?: boolean } = {}): Promise<InboxResult> {
    await this.requireAgent(agentId);
    const [messages, unread] = await Promise.all([
      this.messages.list(agentId),
      this.messages.unread(agentId)
    ]);
    if (options.markRead !== false && unread.length > 0) {
      await this.messages.markRead(agentId, unread[unread.length - 1].id);
    }
    return { messages, unread };
  }

  private async deliver(input: SendMessageInput): Promise<AgentMessage> {
    if (!(await this.store.stateExists(input.to))) {
      throw new Error(`Cannot deliver to an unregistered agent: ${input.to}`);
    }
    const message: AgentMessage = {
      id: createId('msg'),
      from: input.from,
      to: input.to,
      body: input.body,
      pointer: input.pointer,
      kind: input.kind ?? 'direct',
      timestamp: nowIso()
    };
    await this.messages.append(message);

    // Mirrored into the journal so the panel and the feed show that contact happened.
    await this.store.appendActivity(
      this.makeActivity({
        agentId: input.from,
        type: 'MESSAGE',
        description: `-> ${input.to}: ${input.body}`,
        pointer: input.pointer
      }, message.timestamp),
      { history: await this.store.stateExists(input.from) }
    );
    return message;
  }

  /**
   * Records something observed about an agent rather than declared by it — a change found
   * in the working tree, for example. Agent state is never touched: an observer must not
   * overwrite what an agent said it was doing.
   */
  async observe(input: {
    agentId: string;
    description: string;
    pointer?: CodePointer;
    task?: string;
    /** False for observations that belong to no specific agent. */
    history?: boolean;
  }): Promise<AgentActivity> {
    const activity = this.makeActivity({
      agentId: input.agentId,
      type: 'OBSERVED',
      description: input.description,
      pointer: input.pointer,
      task: input.task
    });
    await this.store.appendActivity(activity, { history: input.history !== false });
    await this.store.refreshSharedMemory(await this.config());
    return activity;
  }

  async read(agentId?: string): Promise<string | AgentState> {
    if (agentId) return this.requireAgent(agentId);
    return this.store.readSharedMemory();
  }

  async states(): Promise<AgentState[]> {
    return this.store.listStates();
  }

  private async requireAgent(agentId: string): Promise<AgentState> {
    if (!(await this.store.stateExists(agentId))) {
      throw new Error(`Agent not registered: ${agentId}. Run register first.`);
    }
    return this.store.readState(agentId);
  }

  private makeActivity(input: Omit<ActivityInput, 'status'>, timestamp = nowIso()): AgentActivity {
    return {
      id: createId('evt'),
      agentId: input.agentId,
      type: input.type,
      description: input.description,
      task: input.task,
      pointer: input.pointer,
      reason: input.reason,
      waitingFor: input.waitingFor,
      timestamp
    };
  }
}

function statusFor(type: ActivityType, previous: AgentStatus): AgentStatus {
  switch (type) {
    case 'INTENT':
    case 'FOUND':
    case 'CHANGED':
    case 'CREATED':
      return 'WORKING';
    case 'READING':
      return 'READING';
    case 'TESTING':
      return 'TESTING';
    case 'WAITING':
      return 'WAITING';
    case 'DONE':
      return 'DONE';
    case 'HEARTBEAT':
      return previous === 'OFFLINE' ? 'ONLINE' : previous;
    case 'REGISTERED':
      return 'ONLINE';
    case 'UNREGISTERED':
      return 'OFFLINE';
    case 'NOTE':
    case 'OBSERVED':
    case 'MESSAGE':
      return previous;
  }
}
