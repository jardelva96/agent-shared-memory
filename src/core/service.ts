import path from 'node:path';
import { AgentActivity, AgentMessage, AgentState, AgentStatus, ActivityType, AgentTask, CodePointer, Conflict, ProjectConfig, TaskSchedule, TaskStatus } from '../models/types.js';
import { createId, createScheduleId, createSessionId, createTaskId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import { readConfig, writeConfig, DEFAULT_CONFIG } from './config.js';
import { isLockTimeout, withFileLock } from '../utils/fs.js';
import { parseCron } from './cron.js';
import { ScheduleStore, TaskStore } from './tasks.js';
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

export interface FinishOptions {
  /**
   * Set by the runner: this verdict comes from the process exit code, not from the agent
   * calling memory_task_finish. Only meaningful when the agent recorded nothing itself,
   * since a verdict already given is never overwritten.
   */
  fromExitCode?: boolean;
}

export interface CreateTaskInput {
  title: string;
  createdBy: string;
  detail?: string;
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
   * Queue the review without naming a reviewer: whoever is free takes it, except the agent
   * that did the work. Removes the single point of failure of a named reviewer that is busy
   * or dead, at the cost of not choosing who judges.
   */
  reviewOpen?: boolean;
  /** Marks this task as the review of another. */
  reviewOf?: string;
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

  constructor(public readonly root = process.cwd()) {
    this.store = new MemoryStore(root);
    this.messages = new InboxStore(root);
    this.tasks = new TaskStore(root);
    this.schedules = new ScheduleStore(root);
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
    await this.afterWrite();
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
    await this.afterWrite();
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
    await this.afterWrite(config);
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

  /**
   * Queues work for whoever can take it. Depth is inherited from the task being executed,
   * so a chain of agents spawning agents stops at maxTaskDepth instead of running away.
   */
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

    // A dependency on a task that does not exist can never become DONE, so the task would
    // sit OPEN and unclaimable forever while looking perfectly healthy in the listing.
    // Cheaper to refuse the typo here than to debug a queue that silently stopped moving.
    const dependencies = input.dependsOn
      ? Array.isArray(input.dependsOn)
        ? input.dependsOn
        : [input.dependsOn]
      : [];
    for (const id of dependencies) {
      const exists = await this.tasks.read(id).then(() => true, () => false);
      if (!exists) throw new Error(`Cannot depend on a task that does not exist: ${id}`);
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
      createdAt: now,
      updatedAt: now
    };
    await this.tasks.write(task);

    if (input.reviewBy || input.reviewOpen) {
      // Created here rather than by the executor: the reviewer must exist from the start,
      // so work cannot quietly close without anyone having looked at it.
      const review = await this.createTask({
        title: `Revisar: ${input.title}`,
        detail:
          `Revise o trabalho da tarefa ${task.id}. Verifique de fato (leia o codigo, rode o que ` +
          'houver para rodar). Conclua a revisao como DONE se estiver correto, ou FAILED com o ' +
          'motivo, o que devolve o trabalho para a fila.',
        createdBy: input.createdBy,
        // Left unassigned on purpose when the review is open: the queue hands it to whoever
        // is free, and claim() keeps it away from the agent that did the work.
        assignedTo: input.reviewBy,
        pointer: input.pointer,
        dependsOn: task.id,
        reviewOf: task.id
      });
      task.reviewTaskId = review.id;
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
    const task = await this.tasks.claim(agentId, config.taskClaimSeconds, config.maxTaskAttempts);
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

  /**
   * Closes a task and settles anything waiting on it.
   *
   * A review that rejects sends the work back to the queue with the reason attached,
   * which is the point of separating who does the work from who checks it: "done" stops
   * being self-declared. A review whose work failed has nothing left to judge, so it is
   * cancelled rather than left blocking the queue forever.
   */
  async finishTask(
    id: string,
    status: TaskStatus,
    result?: string,
    by?: string,
    options: FinishOptions = {}
  ): Promise<AgentTask> {
    const task = await this.tasks.finish(id, status, result, by);

    if (task.reviewOf) {
      // A reviewer that died never judged anything. Because tasks.finish ignores a verdict
      // already recorded by the agent, a status arriving here from an exit code proves the
      // agent closed nothing itself -- so this is "could not review", not "rejected".
      if (status !== 'DONE' && options.fromExitCode) {
        await this.retryAbandonedReview(task, result);
      } else {
        await this.settleReview(task, status, result);
      }
    } else if (status !== 'DONE' && task.reviewTaskId) {
      // The work did not land, so its review has nothing to judge.
      await this.tasks
        .finish(task.reviewTaskId, 'CANCELLED', `trabalho ${task.id} terminou como ${status}`)
        .catch(() => undefined);
    }

    const actor = task.claimedBy ?? task.createdBy;
    await this.store.appendActivity(
      this.makeActivity({
        agentId: actor,
        type: 'TASK',
        description: `${status.toLowerCase()} ${task.id}: ${task.title}${result ? ` — ${result}` : ''}`,
        pointer: task.pointer
      }),
      { history: await this.store.stateExists(actor) }
    );

    // Whoever asked for the work should hear how it ended.
    if (task.createdBy !== actor && (await this.store.stateExists(task.createdBy))) {
      await this.deliver({
        from: actor,
        to: task.createdBy,
        body: `Task ${task.id} ${status.toLowerCase()}: ${task.title}${result ? ` — ${result}` : ''}`,
        pointer: task.pointer,
        kind: 'task'
      });
    }

    await this.afterWrite();
    return task;
  }

  /**
   * Puts a review back in the queue when its agent died before judging.
   *
   * Counting a crash as a rejection is expensive twice over: correct work is bounced back
   * to a doer who has nothing to fix, and a round is burned off the rejection limit. A
   * session limit, a dropped connection or an OOM says nothing about the code.
   */
  private async retryAbandonedReview(review: AgentTask, result?: string): Promise<void> {
    const { maxTaskAttempts } = await this.config();
    const now = nowIso();

    // A reviewer that dies every time it runs would otherwise requeue forever. The same
    // attempt budget that dead-letters a poisonous task applies here.
    if (maxTaskAttempts > 0 && review.attempts >= maxTaskAttempts) {
      review.result =
        `revisao abandonada apos ${review.attempts} tentativa(s): o agente terminou sem dar veredito. ` +
        `Ultima saida: ${result ?? 'sem detalhe'}. O trabalho continua sem revisao — precisa de decisao humana.`;
      review.updatedAt = now;
      await this.tasks.write(review);
      return;
    }

    review.status = 'OPEN';
    review.claimedBy = undefined;
    review.claimedAt = undefined;
    review.claimExpiresAt = undefined;
    review.finishedAt = undefined;
    review.result = undefined;
    review.updatedAt = now;
    await this.tasks.write(review);

    await this.store.appendActivity(
      this.makeActivity({
        agentId: review.claimedBy ?? review.createdBy,
        type: 'TASK',
        description: `revisao ${review.id} nao chegou a julgar (${result ?? 'sem detalhe'}); devolvida para a fila`,
        pointer: review.pointer
      }),
      { history: false }
    );
  }

  /** Applies a review verdict to the work it judged. */
  private async settleReview(review: AgentTask, status: TaskStatus, result?: string): Promise<void> {
    if (!review.reviewOf) return;
    let work: AgentTask;
    try {
      work = await this.tasks.read(review.reviewOf);
    } catch {
      return; // The work was removed; nothing to settle.
    }

    if (status === 'DONE') {
      await this.store.appendActivity(
        this.makeActivity({
          agentId: review.claimedBy ?? review.createdBy,
          type: 'TASK',
          description: `revisao aprovou ${work.id}: ${work.title}`,
          pointer: work.pointer
        }),
        { history: false }
      );
      return;
    }

    // Rejected: the work goes back to the queue carrying the reason, so whoever picks it
    // up next starts from the objection instead of repeating the same mistake.
    const rounds = (work.reviewRounds ?? 0) + 1;
    const { maxReviewRounds } = await this.config();
    const now = nowIso();

    // A doer that cannot satisfy its reviewer would otherwise trade rejections with it
    // until someone notices the bill. Past the limit the work stops rather than looping,
    // and a person decides whether the code or the objection is the thing that is wrong.
    if (maxReviewRounds > 0 && rounds >= maxReviewRounds) {
      work.status = 'FAILED';
      work.reviewRounds = rounds;
      work.result =
        `revisao rejeitou ${rounds}x (limite maxReviewRounds=${maxReviewRounds}); ` +
        `ultima objecao: ${result ?? 'sem motivo informado'}. Precisa de decisao humana.`;
      work.finishedAt = now;
      work.claimedBy = undefined;
      work.claimExpiresAt = undefined;
      work.updatedAt = now;
      await this.tasks.write(work);
      await this.store.appendActivity(
        this.makeActivity({
          agentId: review.claimedBy ?? review.createdBy,
          type: 'TASK',
          description: `revisao rejeitou ${work.id} pela ${rounds}a vez: parou no limite, aguarda decisao humana`,
          pointer: work.pointer
        }),
        { history: false }
      );
      return;
    }

    work.status = 'OPEN';
    work.claimedBy = undefined;
    work.claimedAt = undefined;
    work.claimExpiresAt = undefined;
    work.finishedAt = undefined;
    work.reviewRounds = rounds;
    work.result = `revisao rejeitou (${review.id}): ${result ?? 'sem motivo informado'}`;
    work.detail = `${work.detail ?? ''}

REVISAO ANTERIOR REJEITOU: ${result ?? 'sem motivo'}`.trim();
    work.updatedAt = now;
    await this.tasks.write(work);

    // The review that just rejected is spent, and nothing else would ever queue another:
    // the redone work would close with no one looking at it, so the gate would open
    // permanently after exactly one rejection -- the opposite of the point.
    //
    // A fresh review rather than reopening this one. Reopening would put it back to OPEN
    // while its own runner is still exiting, and the exit code would then overwrite the
    // rejection the agent just recorded -- turning a reject into an approval. Leaving each
    // round closed also keeps the objections readable one by one.
    const next = await this.createTask({
      title: `Revisar (rodada ${rounds + 1}): ${work.title}`,
      detail:
        `Revise novamente a tarefa ${work.id}, que voltou para a fila depois da rodada ${rounds}. ` +
        `Objecao anterior: ${result ?? 'sem motivo'}. Verifique de fato (leia o codigo, rode o que ` +
        'houver para rodar). Conclua como DONE se estiver correto, ou FAILED com o motivo.',
      createdBy: review.createdBy,
      // An open review stays open for the next round. Falling back to whoever happened to
      // claim it would quietly pin every later round to the first agent that showed up.
      assignedTo: review.assignedTo,
      pointer: work.pointer,
      dependsOn: work.id,
      reviewOf: work.id
    });
    work.reviewTaskId = next.id;
    work.updatedAt = nowIso();
    await this.tasks.write(work);

    await this.store.appendActivity(
      this.makeActivity({
        agentId: review.claimedBy ?? review.createdBy,
        type: 'TASK',
        description: `revisao rejeitou ${work.id} e devolveu para a fila (rodada ${rounds}): ${result ?? 'sem motivo'}`,
        pointer: work.pointer
      }),
      { history: false }
    );
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

  /**
   * Materialises every schedule whose time has come. Safe to run from several processes:
   * the whole sweep is serialised, and nextRunAt is re-read inside the lock.
   */
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
        // nextRunAt has already advanced, so this occurrence cannot be retried — and one
        // schedule failing must not swallow the others in the same sweep. Record the miss
        // where it will be seen instead of losing it silently.
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

  /** Sends a message to another agent inbox. The recipient must be registered. */
  async sendMessage(input: SendMessageInput): Promise<AgentMessage> {
    const message = await this.deliver(input);
    await this.afterWrite();
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
    await this.afterWrite();
    return activity;
  }

  /**
   * Regenerates the panel and, if the journal has outgrown its limit, archives the old
   * events. The size comes from the refresh, which already read the journal, so the check
   * costs nothing. Every writer runs it, but archiveEvents is idempotent under its lock:
   * whoever gets there first trims, the rest find nothing left to do.
   */
  private async afterWrite(config?: ProjectConfig): Promise<void> {
    const effective = config ?? (await this.config());
    const journalSize = await this.store.refreshSharedMemory(effective);
    const limit = effective.autoCompactAfterEvents ?? 0;
    if (limit <= 0 || journalSize === undefined || journalSize <= limit) return;

    const keep = Math.max(effective.recentHistoryLimit, Math.floor(limit / 2));
    try {
      await this.store.archiveEvents(keep, nowIso().replace(/[:.]/g, '-'));
    } catch (error) {
      // Another agent is already trimming; the write itself is long since durable.
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
    case 'TASK':
      return previous;
  }
}
