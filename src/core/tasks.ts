import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AgentTask, TaskSchedule, TaskStatus } from '../models/types.js';
import { atomicWriteJson, ensureDir, readJson, readJsonIfExists, withFileLock } from '../utils/fs.js';
import { nowIso } from '../utils/time.js';
import { nextOccurrence, parseCron } from './cron.js';
import { resolvePaths } from './paths.js';

const ACTIVE: TaskStatus[] = ['OPEN', 'CLAIMED'];
/** A verdict has been given; nothing may overwrite it. */
const TERMINAL: TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

/** Closed tasks kept in the queue folder; past this, the oldest move to tasks/archive/. */
export const DEFAULT_MAX_CLOSED_TASKS = 200;

/** Files read at once when listing a folder of tasks. */
const READ_BATCH = 64;

/** A review, its work and its other votes are not archived until this long after the last change. */
const ARCHIVE_GRACE_MS = 10 * 60_000;

/** Moved per claim at most, so the queue lock is never held for long. */
const ARCHIVE_BATCH = 1000;

/** `closed` is false when the task was already terminal and this call changed nothing. */
export interface FinishResult {
  task: AgentTask;
  closed: boolean;
}

export interface TaskFilter {
  status?: TaskStatus[];
  agent?: string;
  /** Also read archived tasks. Implied when `status` asks for a closed status. */
  archived?: boolean;
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

  private archiveFile(id: string): string {
    return path.join(this.paths.tasksArchiveDir, `${assertTaskId(id)}.json`);
  }

  async write(task: AgentTask): Promise<void> {
    await atomicWriteJson(this.file(task.id), task);
  }

  async read(id: string): Promise<AgentTask> {
    const task = (await readJsonIfExists<AgentTask>(this.file(id))) ?? (await readJsonIfExists<AgentTask>(this.archiveFile(id)));
    if (!task) throw Object.assign(new Error(`No task ${id}.`), { code: 'ENOENT' });
    return task;
  }

  async list(filter: TaskFilter = {}): Promise<AgentTask[]> {
    const tasks = await readTasks(this.paths.tasksDir);
    if (filter.archived || filter.status?.some(status => TERMINAL.includes(status))) {
      const live = new Set(tasks.map(task => task.id));
      for (const task of await readTasks(this.paths.tasksArchiveDir)) if (!live.has(task.id)) tasks.push(task);
    }

    return tasks
      .filter(task => !filter.status || filter.status.includes(task.status))
      .filter(task => !filter.agent || task.assignedTo === filter.agent || task.claimedBy === filter.agent)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Atomically hands the oldest eligible task to one agent. */
  async claim(
    agentId: string,
    claimSeconds: number,
    maxAttempts = 0,
    maxClosed = DEFAULT_MAX_CLOSED_TASKS
  ): Promise<AgentTask | undefined> {
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
            `abandoned after ${task.attempts} attempt(s): every claim expired without a result. ` +
            'Probably a poison task; review it before requeueing.';
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
      const candidate = readyFor(tasks, agentId, await this.archivedDone(tasks))[0];
      if (candidate) {
        candidate.status = 'CLAIMED';
        candidate.claimedBy = agentId;
        candidate.claimedAt = now;
        candidate.claimExpiresAt = new Date(Date.now() + claimSeconds * 1000).toISOString();
        candidate.attempts += 1;
        candidate.updatedAt = now;
        await this.write(candidate);
      }

      // Housekeeping only: a failed move leaves the task where it was.
      await this.archiveClosed(tasks, maxClosed).catch(() => 0);
      return candidate;
    });
  }

  /** Ids that open tasks depend on and that were archived as DONE. */
  async archivedDone(tasks: AgentTask[]): Promise<Set<string>> {
    const live = new Set(tasks.map(task => task.id));
    const missing = new Set(
      tasks.filter(task => task.status === 'OPEN').flatMap(dependenciesOf).filter(id => !live.has(id))
    );
    const done = new Set<string>();
    await Promise.all(
      [...missing].map(async id => {
        const task = await readJsonIfExists<AgentTask>(this.archiveFile(id)).catch(() => undefined);
        if (task?.status === 'DONE') done.add(id);
      })
    );
    return done;
  }

  /**
   * Moves the oldest closed tasks to tasks/archive/ once more than `maxClosed` sit in the queue
   * folder, keeping the newest half. A task that open work still points at stays, and so does a
   * vote of a review panel that is still open. Returns how many moved.
   */
  async archiveClosed(tasks: AgentTask[], maxClosed: number): Promise<number> {
    const closed = tasks.filter(task => TERMINAL.includes(task.status));
    if (maxClosed <= 0 || closed.length <= maxClosed) return 0;

    const open = tasks.filter(task => !TERMINAL.includes(task.status));
    const pinned = new Set(open.flatMap(task => [...dependenciesOf(task), task.reviewOf, task.parentTaskId]));
    const byId = new Map(tasks.map(task => [task.id, task]));
    // A panel's last vote is written before the votes are counted; in between, the earlier votes
    // are pinned by nothing. Work under review and its votes stay while any of them is recent.
    const since = new Date(Date.now() - ARCHIVE_GRACE_MS).toISOString();
    const recentReviews = new Set(
      tasks.filter(task => (task.reviewOf || task.reviewTaskId) && task.updatedAt > since).map(task => task.reviewOf ?? task.id)
    );
    const movable = closed
      .filter(task => !pinned.has(task.id))
      .filter(task => !recentReviews.has(task.reviewOf ?? task.id))
      .filter(task => !task.reviewOf || !pinned.has(task.reviewOf))
      .filter(task => !task.reviewOf || TERMINAL.includes(byId.get(task.reviewOf)?.status ?? 'DONE'))
      .sort((a, b) => (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt));

    const count = Math.min(movable.length, closed.length - Math.floor(maxClosed / 2), ARCHIVE_BATCH);
    if (count <= 0) return 0;
    await ensureDir(this.paths.tasksArchiveDir);
    let moved = 0;
    for (const task of movable.slice(0, count)) {
      // A rename: the task is in one folder or the other, never neither.
      if (await rename(this.file(task.id), this.archiveFile(task.id)).then(() => true, () => false)) moved++;
    }
    return moved;
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
    await rm(this.archiveFile(id), { force: true });
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
 * first (priority 0 before 4), then oldest. `doneElsewhere` holds archived DONE dependencies.
 */
export function readyFor(tasks: AgentTask[], agentId?: string, doneElsewhere: Set<string> = new Set()): AgentTask[] {
  const done = new Set([...doneElsewhere, ...tasks.filter(task => task.status === 'DONE').map(task => task.id)]);
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

/** Every task in a folder, read in parallel batches; a file that vanished or is torn is skipped. */
async function readTasks(dir: string): Promise<AgentTask[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const tasks: AgentTask[] = [];
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = await Promise.all(
      files.slice(i, i + READ_BATCH).map(file => readJsonIfExists<AgentTask>(path.join(dir, file)).catch(() => undefined))
    );
    for (const task of batch) if (task) tasks.push(task);
  }
  return tasks;
}

/** Ids reach the filesystem as file names, so they are validated like agent ids. */
function assertTaskId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !/[a-zA-Z0-9]/.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(value)}`);
  }
  return id;
}
