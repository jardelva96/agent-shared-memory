import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AgentTask, TaskSchedule, TaskStatus } from '../models/types.js';
import { atomicWriteJson, ensureDir, readJson, withFileLock } from '../utils/fs.js';
import { nowIso } from '../utils/time.js';
import { nextOccurrence, parseCron } from './cron.js';
import { resolvePaths } from './paths.js';

const ACTIVE: TaskStatus[] = ['OPEN', 'CLAIMED'];
/** A verdict has been given; nothing may overwrite it. */
const TERMINAL: TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

/** `closed` is false when the task was already terminal and this call changed nothing. */
export interface FinishResult {
  task: AgentTask;
  closed: boolean;
}

export interface TaskFilter {
  status?: TaskStatus[];
  agent?: string;
}

/** The durable work queue. */
export class TaskStore {
  constructor(public readonly root = process.cwd()) {}

  private get paths() {
    return resolvePaths(this.root);
  }

  private file(id: string): string {
    return path.join(this.paths.tasksDir, `${assertTaskId(id)}.json`);
  }

  async write(task: AgentTask): Promise<void> {
    await atomicWriteJson(this.file(task.id), task);
  }

  async read(id: string): Promise<AgentTask> {
    return readJson<AgentTask>(this.file(id));
  }

  async list(filter: TaskFilter = {}): Promise<AgentTask[]> {
    const dir = this.paths.tasksDir;
    let files: string[];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const tasks: AgentTask[] = [];
    for (const file of files) {
      try {
        tasks.push(await readJson<AgentTask>(path.join(dir, file)));
      } catch {
        // Skip a task being written right now rather than failing the whole listing.
      }
    }

    return tasks
      .filter(task => !filter.status || filter.status.includes(task.status))
      .filter(task => !filter.agent || task.assignedTo === filter.agent || task.claimedBy === filter.agent)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Atomically hands the oldest eligible task to one agent. */
  async claim(agentId: string, claimSeconds: number, maxAttempts = 0): Promise<AgentTask | undefined> {
    const p = this.paths;
    await ensureDir(p.tasksDir);

    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const now = nowIso();
      const tasks = await this.list();

      for (const task of tasks) {
        if (task.status !== 'CLAIMED' || !task.claimExpiresAt || task.claimExpiresAt > now) continue;

        // Fail a task whose claim keeps expiring instead of requeueing it forever.
        if (maxAttempts > 0 && task.attempts >= maxAttempts) {
          task.status = 'FAILED';
          task.result =
            `abandonada apos ${task.attempts} tentativa(s): o claim expirou sem conclusao todas as vezes. ` +
            'Provavel tarefa venenosa: revise antes de reenfileirar.';
          task.finishedAt = now;
          task.claimedBy = undefined;
          task.claimExpiresAt = undefined;
          task.updatedAt = now;
          await this.write(task);
          continue;
        }

        task.status = 'OPEN';
        task.claimedBy = undefined;
        task.claimedAt = undefined;
        task.claimExpiresAt = undefined;
        task.updatedAt = now;
        await this.write(task);
      }

      // Blocked tasks are not handed out.
      const candidate = readyFor(tasks, agentId)[0];
      if (!candidate) return undefined;

      candidate.status = 'CLAIMED';
      candidate.claimedBy = agentId;
      candidate.claimedAt = now;
      candidate.claimExpiresAt = new Date(Date.now() + claimSeconds * 1000).toISOString();
      candidate.attempts += 1;
      candidate.updatedAt = now;
      await this.write(candidate);
      return candidate;
    });
  }

  /** Closes a task. */
  async finish(id: string, status: TaskStatus, result?: string, by?: string): Promise<FinishResult> {
    const p = this.paths;
    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const task = await this.read(id);

      // A recorded verdict is final: a later call from the runner's exit code must not change it.
      if (TERMINAL.includes(task.status)) return { task, closed: false };

      if (by && task.claimedBy && task.claimedBy !== by) {
        throw new Error(
          `${id} is held by ${task.claimedBy}, not ${by}. The claim expired and the task was reassigned.`
        );
      }
      const now = nowIso();
      task.status = status;
      task.result = result;
      task.finishedAt = now;
      task.updatedAt = now;
      task.claimExpiresAt = undefined;
      await this.write(task);
      return { task, closed: true };
    });
  }

  /** Returns a claimed task to the pool without counting it as finished. */
  async release(id: string, by?: string, note?: string): Promise<AgentTask> {
    const p = this.paths;
    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const task = await this.read(id);
      if (task.status !== 'CLAIMED' || (by && task.claimedBy && task.claimedBy !== by)) return task;
      const now = nowIso();
      task.status = 'OPEN';
      task.claimedBy = undefined;
      task.claimedAt = undefined;
      task.claimExpiresAt = undefined;
      if (note !== undefined) task.result = note;
      task.updatedAt = now;
      await this.write(task);
      return task;
    });
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  async countActive(): Promise<number> {
    return (await this.list({ status: ACTIVE })).length;
  }
}

export class ScheduleStore {
  constructor(public readonly root = process.cwd()) {}

  private get paths() {
    return resolvePaths(this.root);
  }

  private file(id: string): string {
    return path.join(this.paths.schedulesDir, `${assertTaskId(id)}.json`);
  }

  async write(schedule: TaskSchedule): Promise<void> {
    await atomicWriteJson(this.file(schedule.id), schedule);
  }

  async read(id: string): Promise<TaskSchedule> {
    return readJson<TaskSchedule>(this.file(id));
  }

  async list(): Promise<TaskSchedule[]> {
    let files: string[];
    try {
      files = (await readdir(this.paths.schedulesDir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    const schedules: TaskSchedule[] = [];
    for (const file of files) {
      try {
        schedules.push(await readJson<TaskSchedule>(path.join(this.paths.schedulesDir, file)));
      } catch {
        // Skip a schedule being written right now.
      }
    }
    return schedules.sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /** Recomputes when a schedule should next fire, from `after`. */
  static computeNextRun(cron: string, after: Date = new Date()): string | undefined {
    return nextOccurrence(parseCron(cron), after)?.toISOString();
  }
}

/** True when `agentId` did the work under review or already sits on the same review panel. */
function cannotJudge(
  task: AgentTask,
  agentId: string,
  byId: Map<string, AgentTask>,
  all: AgentTask[]
): boolean {
  if (!task.reviewOf) return false;
  if (byId.get(task.reviewOf)?.claimedBy === agentId) return true;

  const round = task.reviewRound ?? 1;
  return all.some(
    other =>
      other.id !== task.id &&
      other.reviewOf === task.reviewOf &&
      (other.reviewRound ?? 1) === round &&
      other.claimedBy === agentId
  );
}

/**
 * The tasks `agentId` could claim right now, in the order the queue hands them out: most urgent
 * first (priority 0 before 4), then oldest.
 */
export function readyFor(tasks: AgentTask[], agentId?: string): AgentTask[] {
  const done = new Set(tasks.filter(task => task.status === 'DONE').map(task => task.id));
  const byId = new Map(tasks.map(task => [task.id, task]));
  return tasks
    .filter(
      task =>
        task.status === 'OPEN' &&
        (!task.assignedTo || !agentId || task.assignedTo === agentId) &&
        dependenciesOf(task).every(id => done.has(id)) &&
        (!agentId || !cannotJudge(task, agentId, byId, tasks))
    )
    .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || a.createdAt.localeCompare(b.createdAt));
}

/** Normalises the single-value form tasks written before dependsOn took a list. */
export function dependenciesOf(task: AgentTask): string[] {
  if (!task.dependsOn) return [];
  return Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn];
}

/** Ids reach the filesystem as file names, so they are validated like agent ids. */
function assertTaskId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !/[a-zA-Z0-9]/.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(value)}`);
  }
  return id;
}
