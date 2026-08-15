import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AgentTask, TaskSchedule, TaskStatus } from '../models/types.js';
import { atomicWriteJson, ensureDir, readJson, withFileLock } from '../utils/fs.js';
import { nowIso } from '../utils/time.js';
import { nextOccurrence, parseCron } from './cron.js';
import { resolvePaths } from './paths.js';

const ACTIVE: TaskStatus[] = ['OPEN', 'CLAIMED'];

export interface TaskFilter {
  status?: TaskStatus[];
  agent?: string;
}

/**
 * The durable work queue. A message is missed if nobody reads it; a task waits until
 * someone claims and finishes it, which is what makes delegation survive a session.
 */
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

  /**
   * Atomically hands the oldest eligible task to one agent.
   *
   * Runs under a queue-wide lock so two runners can never take the same task, and
   * reclaims expired claims first so work abandoned by a dead runner is picked up again.
   */
  async claim(agentId: string, claimSeconds: number, maxAttempts = 0): Promise<AgentTask | undefined> {
    const p = this.paths;
    await ensureDir(p.tasksDir);

    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const now = nowIso();
      const tasks = await this.list();

      for (const task of tasks) {
        if (task.status !== 'CLAIMED' || !task.claimExpiresAt || task.claimExpiresAt > now) continue;

        // A task that keeps killing its runner would otherwise return here forever, and
        // to the *front* of the queue: its createdAt never changes, so it outranks
        // everything queued since. Retried enough times, it is the task that is broken.
        if (maxAttempts > 0 && task.attempts >= maxAttempts) {
          task.status = 'FAILED';
          task.result =
            `abandonada apos ${task.attempts} tentativa(s): o claim expirou sem conclusao todas as vezes. ` +
            'Provavel tarefa venenosa — revise antes de reenfileirar.';
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

      // A blocked task stays invisible to the queue rather than being handed out early.
      // This is what lets a plan run before the work, and a review run after it, without
      // anyone sequencing the waves by hand.
      const done = new Set(tasks.filter(task => task.status === 'DONE').map(task => task.id));
      const candidate = tasks.find(
        task =>
          task.status === 'OPEN' &&
          (!task.assignedTo || task.assignedTo === agentId) &&
          (!task.dependsOn || done.has(task.dependsOn))
      );
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

  /**
   * Closes a task. When `by` is given, only the holder of the claim may close it.
   *
   * A runner whose lease expired has already had the task handed to someone else; letting
   * it write the result anyway would overwrite the new holder's work with the output of a
   * run everyone had given up on.
   */
  async finish(id: string, status: TaskStatus, result?: string, by?: string): Promise<AgentTask> {
    const p = this.paths;
    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const task = await this.read(id);
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
      return task;
    });
  }

  /** Returns a claimed task to the pool without counting it as finished. */
  async release(id: string): Promise<AgentTask> {
    const p = this.paths;
    return withFileLock(path.join(p.locksDir, 'tasks.lock'), async () => {
      const task = await this.read(id);
      const now = nowIso();
      task.status = 'OPEN';
      task.claimedBy = undefined;
      task.claimedAt = undefined;
      task.claimExpiresAt = undefined;
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

/** Ids reach the filesystem as file names, so they are validated like agent ids. */
function assertTaskId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !/[a-zA-Z0-9]/.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(value)}`);
  }
  return id;
}
