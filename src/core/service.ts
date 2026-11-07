import path from 'node:path';
import { AgentActivity, AgentMessage, AgentState, AgentStatus, ActivityType, AgentTask, CodePointer, Conflict, GuardContext, ProjectConfig, ProjectFact, TaskSchedule, TaskStatus } from '../models/types.js';
import { createId, createScheduleId, createSessionId, createTaskId } from '../utils/ids.js';
import { localTime, nowIso } from '../utils/time.js';
import { readConfig, writeConfig, DEFAULT_CONFIG } from './config.js';
import { isLockTimeout, withFileLock } from '../utils/fs.js';
import { parseCron } from './cron.js';
import { readyFor, ScheduleStore, TaskStore } from './tasks.js';
import { detectConflicts } from './conflicts.js';
import { FactStore } from './facts.js';
import { InboxStore } from './inbox.js';
import { formatPointer, pointerKey } from './pointer.js';
import { effectiveStatus } from './render.js';
import { ReservationStore, ReserveOptions, ReserveResult } from './reservations.js';
import { ReviewDesk } from './reviews.js';
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

export interface FinishOptions {
  /**
   * Set by the runner: this verdict comes from the process exit code, not from the agent calling
   * memory_task_finish.
   */
  fromExitCode?: boolean;
}

export interface CreateTaskInput {
  title: string;
  createdBy: string;
  detail?: string;
  /** 0 (most urgent) to 4. */
  priority?: number;
  pointer?: CodePointer;
  assignedTo?: string;
  /** Set when a runner creates a task while executing one, to bound spawn depth. */
  parentTaskId?: string;
  scheduleId?: string;
  /** The task is not claimable until every one of these is DONE. */
  dependsOn?: string | string[];
  /** Queue a linked review task for this agent, unblocked when the work lands. */
  reviewBy?: string;
  /**
   * Queue the review without naming a reviewer: whoever is free takes it, except the agent that did
   * the work.
   */
  reviewOpen?: boolean;
  /** How many agents must judge the work. */
  reviewers?: number;
  /** Marks this task as the review of another. */
  reviewOf?: string;
  /** Set on a review task: which round of judging it belongs to. */
  reviewRound?: number;
}

export interface CreateScheduleInput {
  cron: string;
  title: string;
  createdBy: string;
  detail?: string;
  pointer?: CodePointer;
  assignedTo?: string;
}

export class AgentMemoryService {
  readonly store: MemoryStore;
  readonly messages: InboxStore;
  readonly tasks: TaskStore;
  readonly schedules: ScheduleStore;
  readonly reservations: ReservationStore;
  readonly facts: FactStore;
  private readonly reviews: ReviewDesk;

  constructor(public readonly root = process.cwd()) {
    this.store = new MemoryStore(root);
    this.messages = new InboxStore(root);
    this.tasks = new TaskStore(root);
    this.schedules = new ScheduleStore(root);
    this.reservations = new ReservationStore(root);
    this.facts = new FactStore(root);
    this.reviews = new ReviewDesk({
      tasks: this.tasks,
      config: () => this.config(),
      createTask: input => this.createTask(input),
      note: (agentId, description, pointer) =>
        this.store.appendActivity(this.makeActivity({ agentId, type: 'TASK', description, pointer }), { history: false })
    });
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
    // Passing the new config means lowering the threshold takes effect immediately.
    await this.afterWrite(next);
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
    await this.afterWrite();
    return state;
  }

  /** Starts a fresh session for an agent that already exists, keeping its history. */
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
    await this.afterWrite();
    return state;
  }

  /** Removes an agent from the shared panel. */
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
    // Release the agent's reservations so they do not block others until they expire.
    await this.reservations.release(agentId).catch(() => 0);
    await this.afterWrite();
    return state;
  }

  /** Reserves files, folders or globs for this agent. */
  async reserve(agentId: string, patterns: string[], options: ReserveOptions = {}): Promise<ReserveResult> {
    await this.requireAgent(agentId);
    const result = await this.reservations.reserve(agentId, patterns, options);
    if (result.granted.length > 0) {
      const first = result.granted[0];
      await this.store.appendActivity(
        this.makeActivity({
          agentId,
          type: 'NOTE',
          description:
            `reserved ${result.granted.map(r => r.pattern).join(', ')} (${first.exclusive ? 'exclusive' : 'shared'} until ${localTime(first.expiresAt)})` +
            (first.reason ? `: ${first.reason}` : ''),
          pointer: { file: first.pattern }
        })
      );
      await this.afterWrite();
    }
    return result;
  }

  /** Releases this agent's reservations on these patterns, or all of them. */
  async release(agentId: string, patterns?: string[]): Promise<number> {
    const released = await this.reservations.release(agentId, patterns);
    if (released > 0 && (await this.store.stateExists(agentId))) {
      await this.store.appendActivity(
        this.makeActivity({ agentId, type: 'NOTE', description: `released ${patterns?.length ? patterns.join(', ') : `all ${released} reservation(s)`}` })
      );
      await this.afterWrite();
    }
    return released;
  }

  async remember(text: string, createdBy: string): Promise<ProjectFact> {
    const fact = await this.facts.remember(text, createdBy);
    await this.afterWrite();
    return fact;
  }

  async forget(id: string): Promise<boolean> {
    const removed = await this.facts.forget(id);
    if (removed) await this.afterWrite();
    return removed;
  }

  /** Returns a claimed task to the queue unfinished, for another agent. */
  async releaseTask(id: string, agentId: string, note?: string): Promise<AgentTask> {
    const task = await this.tasks.release(id, agentId, note);
    if (task.status === 'OPEN') {
      await this.store.appendActivity(
        this.makeActivity({ agentId, type: 'TASK', description: `released ${id} back to the queue${note ? `: ${note}` : ''}`, pointer: task.pointer }),
        { history: await this.store.stateExists(agentId) }
      );
      await this.afterWrite();
    }
    return task;
  }

  /** What `agentId` could claim right now, most urgent first; without an agent, all unblocked work. */
  async readyTasks(agentId?: string): Promise<AgentTask[]> {
    const tasks = await this.tasks.list();
    return readyFor(tasks, agentId, await this.tasks.archivedDone(tasks));
  }

  /**
   * Everything that happened to one task: the task itself, the reviews that judged it and every
   * journal entry that names it, oldest first.
   */
  async taskHistory(id: string): Promise<{ task: AgentTask; reviews: AgentTask[]; events: AgentActivity[] }> {
    const task = await this.tasks.read(id);
    const all = await this.tasks.list({ archived: true });
    const reviews = all.filter(t => t.reviewOf === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ids = new Set([id, ...reviews.map(r => r.id)]);
    const events = (await this.store.recentActivities(100_000))
      .filter(event => [...ids].some(taskId => event.description.includes(taskId) || event.task === taskId))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { task, reviews, events };
  }

  /**
   * What an agent needs at the start of a session, in one short text: the rules, the facts, who is
   * doing what, which files are taken, what work is ready and what is waiting for it.
   */
  async prime(agentId?: string): Promise<string> {
    const config = await this.config();
    const [states, reservations, facts, ready] = await Promise.all([
      this.store.listStates(),
      this.reservations.active(),
      this.facts.list(),
      this.readyTasks(agentId)
    ]);
    const lines = [`# Agent Shared Memory: ${config.projectName}`, ''];
    if (agentId) lines.push(`You are ${agentId}. Other agents may be working in this repository at the same time.`, '');
    const rules = config.primeRules?.length
      ? config.primeRules
      : [
          'Before changing a file, reserve it (memory_reserve, or `agent-memory reserve`). A file another agent reserved is theirs until released.',
          'Change one function or class with memory_replace_symbol instead of rewriting the file: it re-reads the file at write time, so other agents\' changes survive.',
          'Read code by pointer (memory_read_pointer "file::Type.member") instead of whole files.',
          'After a change, record it (memory_record CHANGED); release your reservations when done.'
        ];
    lines.push('How to work here:', ...rules.map(rule => `- ${rule}`), '');
    if (facts.length) lines.push('Project facts:', ...facts.map(f => `- ${f.text}`), '');
    const others = states.filter(s => s.id !== agentId && effectiveStatus(s, config) !== 'OFFLINE');
    if (others.length) {
      lines.push('Agents active now:', ...others.map(s => `- ${s.id}: ${s.current?.description ?? '-'}${s.current?.pointer ? ` (${formatPointer(s.current.pointer)})` : ''}`), '');
    }
    if (reservations.length) {
      lines.push('Reserved files:', ...reservations.map(r => `- ${r.pattern}: ${r.agentId}, ${r.exclusive ? 'exclusive' : 'shared'} until ${localTime(r.expiresAt)}`), '');
    }
    if (ready.length) {
      lines.push(
        `Ready tasks (${ready.length}):`,
        ...ready.slice(0, 10).map(t => `- ${t.id} [P${t.priority ?? 2}] ${t.title}${t.assignedTo ? ` (for ${t.assignedTo})` : ''}`),
        ''
      );
    }
    if (agentId && (await this.store.stateExists(agentId))) {
      const unread = await this.messages.unreadCount(agentId);
      if (unread > 0) lines.push(`You have ${unread} unread message(s): memory_inbox.`, '');
    }
    return lines.join('\n').trimEnd() + '\n';
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

    await this.afterWrite();
    return result;
  }

  async heartbeat(agentId: string): Promise<AgentState> {
    const state = await this.requireAgent(agentId);
    const now = nowIso();
    const next: AgentState = { ...state, lastHeartbeatAt: now, updatedAt: now };
    await this.store.writeState(next);
    await this.afterWrite();
    return next;
  }

  async activity(input: ActivityInput): Promise<ActivityResult> {
    const state = await this.requireAgent(input.agentId);
    const states = await this.store.listStates();
    const config = await this.config();
    const conflicts = detectConflicts(states, input.agentId, input.pointer, config);
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
    await this.notifyOverlap(input, state, conflicts);
    await this.afterWrite(config);
    return { activity, state: next, conflicts };
  }

  /** Tells every agent already on the same file or symbol, not only the newcomer. */
  private async notifyOverlap(input: ActivityInput, previous: AgentState, conflicts: Conflict[]): Promise<void> {
    if (!input.pointer || conflicts.length === 0) return;
    // A write is what makes everyone else's copy stale, so every write is announced.
    const wrote = input.type === 'CHANGED' || input.type === 'CREATED';
    if (!wrote && previous.current?.pointer?.file === input.pointer.file) return;

    for (const conflict of conflicts) {
      if (conflict.agentId === input.agentId) continue;
      await this.deliver({
        from: input.agentId,
        to: conflict.agentId,
        body: wrote
          ? `${input.agentId} just changed ${formatPointer(input.pointer)}: ${input.description}. ` +
            'Your copy is stale: re-read it before you write, and keep their change.'
          : `${input.agentId} is now also working on ${formatPointer(input.pointer)}: ${input.description}. ` +
            'Re-read it right before you write, and keep their change.',
        pointer: input.pointer,
        kind: 'overlap'
      }, { history: false }).catch(() => undefined);
    }
  }

  /** Notifies the agent being waited for. */
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

  /** Queues work for whoever can take it. */
  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const config = await this.config();
    let depth = 0;

    if (input.parentTaskId) {
      const parent = await this.tasks.read(input.parentTaskId);
      depth = parent.depth + 1;
      if (depth > config.maxTaskDepth) {
        throw new Error(
          `Task depth limit reached (${config.maxTaskDepth}): ${input.parentTaskId} is already ${parent.depth} deep. ` +
            'Raise maxTaskDepth only if the chain is genuinely needed.'
        );
      }
    }

    if (input.assignedTo && !(await this.store.stateExists(input.assignedTo))) {
      throw new Error(`Cannot assign to an unregistered agent: ${input.assignedTo}`);
    }

    // Reject dependencies on unknown tasks: they would never become DONE.
    const dependencies = input.dependsOn
      ? Array.isArray(input.dependsOn)
        ? input.dependsOn
        : [input.dependsOn]
      : [];
    for (const id of dependencies) {
      const exists = await this.tasks.read(id).then(() => true, () => false);
      if (!exists) throw new Error(`Cannot depend on a task that does not exist: ${id}`);
    }

    const panel = normaliseReviewers(input.reviewers);
    const wantsReview = input.reviewBy || input.reviewOpen || panel > 0;
    if (panel > 1 && input.reviewBy) {
      throw new Error('reviewers > 1 needs an open review: naming one agent gives one opinion, not a majority.');
    }

    const now = nowIso();
    const task: AgentTask = {
      id: createTaskId(),
      title: input.title,
      detail: input.detail,
      pointer: input.pointer,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo,
      status: 'OPEN',
      attempts: 0,
      depth,
      parentTaskId: input.parentTaskId,
      scheduleId: input.scheduleId,
      dependsOn: input.dependsOn,
      reviewOf: input.reviewOf,
      reviewRound: input.reviewRound,
      priority: normalisePriority(input.priority),
      createdAt: now,
      updatedAt: now
    };
    await this.tasks.write(task);

    if (wantsReview) {
      // A panel of one is the ordinary case and stays a single task.
      const seats = panel || 1;
      task.reviewers = seats;
      const reviews = await this.reviews.queuePanel(task, 1, input.createdBy, input.reviewBy, seats);
      task.reviewTaskId = reviews[0].id;
      task.updatedAt = nowIso();
      await this.tasks.write(task);
    }

    await this.store.appendActivity(
      this.makeActivity({
        agentId: input.createdBy,
        type: 'TASK',
        description: `queued ${task.id}: ${task.title}${task.assignedTo ? ` (for ${task.assignedTo})` : ''}`,
        pointer: input.pointer
      }, now),
      { history: await this.store.stateExists(input.createdBy) }
    );

    // An assigned task is also a message, so the agent sees it where it already looks.
    if (input.assignedTo && input.assignedTo !== input.createdBy) {
      await this.deliver({
        from: input.createdBy,
        to: input.assignedTo,
        body: `Task ${task.id} assigned to you: ${task.title}`,
        pointer: input.pointer,
        kind: 'task'
      });
    }

    await this.afterWrite(config);
    return task;
  }

  async claimTask(agentId: string): Promise<AgentTask | undefined> {
    await this.requireAgent(agentId);
    const config = await this.config();
    const task = await this.tasks.claim(agentId, config.taskClaimSeconds, config.maxTaskAttempts, config.maxClosedTasks);
    if (!task) return undefined;

    await this.store.appendActivity(
      this.makeActivity({
        agentId,
        type: 'TASK',
        description: `claimed ${task.id}: ${task.title}`,
        pointer: task.pointer
      })
    );
    await this.afterWrite(config);
    return task;
  }

  /** Closes a task and settles anything waiting on it. */
  async finishTask(
    id: string,
    status: TaskStatus,
    result?: string,
    by?: string,
    options: FinishOptions = {}
  ): Promise<AgentTask> {
    const { task, closed } = await this.tasks.finish(id, status, result, by);

    // Already closed: settling again would count the same vote twice.
    if (!closed) return task;

    if (task.reviewOf) {
      // A failure from the exit code means the reviewer gave no verdict, so the review is retried.
      if (status !== 'DONE' && options.fromExitCode) {
        await this.reviews.retryAbandoned(task, result);
      } else {
        await this.reviews.settle(task, status, result);
      }
    } else if (status !== 'DONE' && task.reviewTaskId) {
      // The work did not land, so its review has nothing to judge.
      await this.tasks
        .finish(task.reviewTaskId, 'CANCELLED', `work ${task.id} ended as ${status}`)
        .catch(() => undefined);
    }

    const actor = task.claimedBy ?? task.createdBy;
    await this.store.appendActivity(
      this.makeActivity({
        agentId: actor,
        type: 'TASK',
        description: `${status.toLowerCase()} ${task.id}: ${task.title}${result ? ` - ${result}` : ''}`,
        pointer: task.pointer
      }),
      { history: await this.store.stateExists(actor) }
    );

    // Whoever asked for the work should hear how it ended.
    if (task.createdBy !== actor && (await this.store.stateExists(task.createdBy))) {
      await this.deliver({
        from: actor,
        to: task.createdBy,
        body: `Task ${task.id} ${status.toLowerCase()}: ${task.title}${result ? ` - ${result}` : ''}`,
        pointer: task.pointer,
        kind: 'task'
      });
    }

    await this.afterWrite();
    return task;
  }

  async createSchedule(input: CreateScheduleInput): Promise<TaskSchedule> {
    parseCron(input.cron); // Reject a bad expression now, not at the first tick.
    const now = nowIso();
    const schedule: TaskSchedule = {
      id: createScheduleId(),
      cron: input.cron.trim(),
      title: input.title,
      detail: input.detail,
      pointer: input.pointer,
      assignedTo: input.assignedTo,
      enabled: true,
      createdBy: input.createdBy,
      nextRunAt: ScheduleStore.computeNextRun(input.cron),
      createdAt: now,
      updatedAt: now
    };
    await this.schedules.write(schedule);
    return schedule;
  }

  /** Materialises every schedule whose time has come. */
  async runDueSchedules(now: Date = new Date()): Promise<AgentTask[]> {
    const created: AgentTask[] = [];
    const lock = path.join(this.store.paths.locksDir, 'schedules.lock');

    const due = await withFileLock(lock, async () => {
      const ready: TaskSchedule[] = [];
      for (const schedule of await this.schedules.list()) {
        if (!schedule.enabled || !schedule.nextRunAt) continue;
        if (new Date(schedule.nextRunAt) > now) continue;
        ready.push(schedule);
        // Advance before releasing the lock so no other scheduler fires the same slot.
        schedule.lastRunAt = now.toISOString();
        schedule.nextRunAt = ScheduleStore.computeNextRun(schedule.cron, now);
        schedule.updatedAt = nowIso();
        await this.schedules.write(schedule);
      }
      return ready;
    });

    for (const schedule of due) {
      try {
        created.push(
          await this.createTask({
            title: schedule.title,
            detail: schedule.detail,
            pointer: schedule.pointer,
            assignedTo: schedule.assignedTo,
            createdBy: schedule.createdBy,
            scheduleId: schedule.id
          })
        );
      } catch (error) {
        // One failing schedule must not stop the others in this sweep.
        await this.store
          .appendActivity(
            this.makeActivity({
              agentId: schedule.createdBy,
              type: 'NOTE',
              description:
                `agendamento ${schedule.id} ("${schedule.title}") perdeu a ocorrencia: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              pointer: schedule.pointer
            }),
            { history: false }
          )
          .catch(() => undefined);
      }
    }
    return created;
  }

  /** Sends a message to another agent inbox. */
  async sendMessage(input: SendMessageInput): Promise<AgentMessage> {
    const message = await this.deliver(input);
    await this.afterWrite();
    return message;
  }

  /** Reads an agent inbox. */
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

  private async deliver(input: SendMessageInput, options: { history?: boolean } = {}): Promise<AgentMessage> {
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
      { history: options.history !== false && (await this.store.stateExists(input.from)) }
    );
    return message;
  }

  /**
   * Records something observed about an agent rather than declared by it, such as a change in the
   * working tree.
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
    await this.afterWrite();
    return activity;
  }

  /** Regenerates the panel and, if the journal has outgrown its limit, archives the old events. */
  private async afterWrite(config?: ProjectConfig): Promise<void> {
    const effective = config ?? (await this.config());
    const journalSize = await this.store.refreshSharedMemory(effective);
    const limit = effective.autoCompactAfterEvents ?? 0;
    if (limit <= 0 || journalSize === undefined || journalSize <= limit) return;

    const keep = Math.max(effective.recentHistoryLimit, Math.floor(limit / 2));
    try {
      await this.store.archiveEvents(keep, nowIso().replace(/[:.]/g, '-'));
    } catch (error) {
      // Another agent is already compacting; the write itself already succeeded.
      if (!isLockTimeout(error)) throw error;
    }
  }

  async read(agentId?: string): Promise<string | AgentState> {
    if (agentId) return this.requireAgent(agentId);
    return this.store.readSharedMemory();
  }

  async states(): Promise<AgentState[]> {
    return this.store.listStates();
  }

  // ----- Shell guard -----

  /**
   * Remembers which checkouts the agent's shell command works in and when the command started.
   * `clear` forgets them, at the end of a session, so a finished session blocks nobody.
   */
  async notePlaces(agentId: string, places: string[], options: { startedAt?: string; clear?: boolean; summary?: string } = {}): Promise<void> {
    if (!(await this.store.stateExists(agentId))) return;
    const state = await this.store.readState(agentId);
    const now = nowIso();
    const next: AgentState = { ...state, lastHeartbeatAt: now };
    if (options.clear) {
      delete next.places;
      delete next.touched;
      delete next.shellStartedAt;
      next.status = 'OFFLINE';
    } else {
      next.places = newestEntries({ ...(state.places ?? {}), ...Object.fromEntries(places.map(p => [p, now])) }, 40);
      if (options.startedAt) next.shellStartedAt = options.startedAt;
      if (options.summary) next.lastShell = options.summary.slice(0, 80);
      // A resumed session is back.
      if (state.status === 'OFFLINE') next.status = 'ONLINE';
    }
    await this.store.writeState(next);
  }

  /** Keeps, as the agent's own, the files its shell command wrote: those changed after it started. */
  async noteShellWrites(agentId: string, files: Array<{ path: string; modifiedMs: number }>): Promise<string[]> {
    if (!(await this.store.stateExists(agentId))) return [];
    const state = await this.store.readState(agentId);
    const start = state.shellStartedAt ? Date.parse(state.shellStartedAt) : NaN;
    if (!Number.isFinite(start)) return [];
    // File times can trail the clock a little; two seconds of slack.
    const mine = files.filter(f => f.modifiedMs >= start - 2000).map(f => f.path);
    if (mine.length === 0) return [];
    const now = nowIso();
    const touched = newestEntries({ ...(state.touched ?? {}), ...Object.fromEntries(mine.map(f => [f, now])) }, 500);
    await this.store.writeState({ ...state, touched });
    return mine;
  }

  /** Who else was in a checkout since `since`, which git commands they ran there, and what this agent wrote. */
  async guardContext(agentId: string, place: string, since: string): Promise<GuardContext> {
    const sinceMs = Date.parse(since);
    const inPlace = (file?: string): file is string =>
      !!file && (place === '.' || file === place || file.startsWith(`${place}/`));
    const states = await this.store.listStates();
    // Only sessions that still exist and have not ended (SessionEnd) are in the way: an unregistered
    // or finished one left events in the journal, not work in the checkout.
    const live = new Set(states.filter(s => s.status !== 'OFFLINE').map(s => s.id));
    const others = new Map<string, GuardContext['others'][number]>();
    const seen = (entry: GuardContext['others'][number]) => {
      if (!live.has(entry.id)) return;
      const previous = others.get(entry.id);
      if (!previous || previous.at < entry.at) others.set(entry.id, entry);
    };
    for (const s of states) {
      const at = s.places?.[place];
      if (s.id !== agentId && at && Date.parse(at) >= sinceMs) seen({ id: s.id, at, how: 'shell', doing: s.lastShell ?? s.current?.description });
    }
    const mine = new Set<string>();
    const me = states.find(s => s.id === agentId);
    for (const [file, at] of Object.entries(me?.touched ?? {})) {
      if (Date.parse(at) >= sinceMs && inPlace(file)) mine.add(file);
    }
    const gitOps: GuardContext['gitOps'] = [];
    for (const event of await this.store.recentActivities(2000)) {
      if (Date.parse(event.timestamp) < sinceMs) continue;
      const file = event.pointer?.file;
      if (event.agentId === agentId) {
        if ((event.type === 'CHANGED' || event.type === 'CREATED') && inPlace(file)) mine.add(file);
        continue;
      }
      if (event.type === 'NOTE' && event.description.startsWith('git: ') && file === place) {
        if (!live.has(event.agentId)) continue;
        gitOps.push({ id: event.agentId, at: event.timestamp, description: event.description.slice(5) });
        seen({ id: event.agentId, at: event.timestamp, how: 'shell', doing: event.description });
        continue;
      }
      if ((event.type === 'CHANGED' || event.type === 'CREATED' || event.type === 'INTENT') && inPlace(file)) {
        seen({ id: event.agentId, at: event.timestamp, how: 'edit', doing: event.description });
      }
    }
    return { others: [...others.values()], gitOps, mine: [...mine] };
  }

  /** A line in the journal about the guard: what it let through, blocked, or was told to let through. */
  async noteGuard(agentId: string, description: string, place?: string): Promise<void> {
    await this.store.appendActivity(
      this.makeActivity({ agentId, type: 'NOTE', description, ...(place ? { pointer: { file: place } } : {}) }),
      { history: false }
    );
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

/** The newest entries of a name-to-time map, none older than a day. */
function newestEntries(map: Record<string, string>, max: number): Record<string, string> {
  const cutoff = Date.now() - 24 * 3600_000;
  return Object.fromEntries(
    Object.entries(map)
      .filter(([, at]) => Date.parse(at) >= cutoff)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, max)
  );
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
    case 'TASK':
      return previous;
  }
}

function normalisePriority(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error('priority must be a whole number from 0 (most urgent) to 4.');
  }
  return value;
}

function normaliseReviewers(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('reviewers must be a positive integer.');
  }
  if (value > 9) {
    throw new Error('reviewers must be 9 or fewer; queue a smaller panel or split the work.');
  }
  return value;
}
