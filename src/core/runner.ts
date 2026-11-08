import { spawn } from 'node:child_process';
import { AgentMemoryService } from './service.js';
import { AgentTask } from '../models/types.js';
import { formatPointer } from './pointer.js';

export interface RunnerOptions {
  agentId: string;
  /** Shell command to run per task. */
  exec: string;
  intervalMs?: number;
  /** Stop after this many tasks; 0 means run until interrupted. */
  maxTasks?: number;
  /** Return as soon as no task is ready instead of waiting for one (also the case when maxTasks is unset). */
  once?: boolean;
  timeoutMs?: number;
  /** Stop once the accumulated cost passes this, so a cascade cannot drain a session. */
  maxCostUsd?: number;
  onEvent?: (line: string) => void;
}

export interface RunOutcome {
  task: AgentTask;
  status: 'DONE' | 'FAILED';
  exitCode: number | null;
  output: string;
  /** Parsed from the executor output when it reports one, for budget accounting. */
  costUsd?: number;
}

const OUTPUT_LIMIT = 2000;

/** Executes one claimed task. */
export async function executeTask(
  service: AgentMemoryService,
  task: AgentTask,
  options: RunnerOptions
): Promise<RunOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_ID: options.agentId,
    AGENT_MEMORY_ROOT: service.root,
    AGENT_TASK_ID: task.id,
    AGENT_TASK_TITLE: task.title,
    AGENT_TASK_DETAIL: task.detail ?? '',
    AGENT_TASK_POINTER: task.pointer ? formatPointer(task.pointer) : '',
    AGENT_TASK_POINTER_FILE: task.pointer?.file ?? '',
    AGENT_TASK_DEPTH: String(task.depth),
    AGENT_TASK_ATTEMPT: String(task.attempts)
  };

  return new Promise<RunOutcome>(resolve => {
    const child = spawn(expandCommand(options.exec, task), {
      shell: true,
      cwd: service.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group on POSIX, so the timeout can signal the whole tree at once.
      detached: process.platform !== 'win32'
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_LIMIT * 4) output = output.slice(-OUTPUT_LIMIT * 4);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const tail = output.trim().slice(-OUTPUT_LIMIT);
      const combined = [note, tail].filter(Boolean).join(' ');
      resolve({
        task,
        status: exitCode === 0 && !timedOut ? 'DONE' : 'FAILED',
        exitCode,
        output: combined,
        costUsd: readCost(combined)
      });
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
          // Settle now instead of waiting for `close`: a grandchild may keep the pipes open.
          settle(null, 'timed out;');
        }, options.timeoutMs)
      : undefined;

    child.on('error', error => settle(null, `could not start: ${error.message}`));
    child.on('close', code => settle(code));
  });
}

/** Claims and executes tasks until stopped. */
/** Exit code (sysexits EX_TEMPFAIL) with which an executor says it cannot work right now. */
export const TEMPORARY_FAILURE = 75;

export async function runQueue(
  service: AgentMemoryService,
  options: RunnerOptions,
  shouldStop: () => boolean = () => false
): Promise<RunOutcome[]> {
  const log = options.onEvent ?? (() => undefined);
  const interval = options.intervalMs ?? 3000;
  const outcomes: RunOutcome[] = [];
  let spent = 0;

  while (!shouldStop()) {
    const task = await service.claimTask(options.agentId);

    if (!task) {
      if (options.once || options.maxTasks === undefined) return outcomes; // single sweep
      await new Promise(resolve => setTimeout(resolve, interval));
      continue;
    }

    log(`claimed ${task.id}: ${task.title}`);
    const outcome = await executeTask(service, task, options);
    // Record the result first: finishTask can throw (lost claim, lock contention).
    outcomes.push(outcome);

    // Exit 75 (EX_TEMPFAIL) means "this agent cannot work right now": out of quota, rate limited.
    if (outcome.exitCode === TEMPORARY_FAILURE) {
      await service.releaseTask(task.id, options.agentId, summarise(outcome)).catch(() => undefined);
      log(`released ${task.id}: the agent cannot work right now (exit ${TEMPORARY_FAILURE}); stopping`);
      return outcomes;
    }

    try {
      await service.finishTask(task.id, outcome.status, summarise(outcome), options.agentId, {
        fromExitCode: true
      });
      log(`${outcome.status.toLowerCase()} ${task.id} (exit ${outcome.exitCode ?? 'n/a'})`);
    } catch (error) {
      log(`${task.id} ran but could not be closed: ${error instanceof Error ? error.message : String(error)}`);
    }

    spent += outcome.costUsd ?? 0;
    if (options.maxCostUsd !== undefined && options.maxCostUsd > 0 && spent >= options.maxCostUsd) {
      log(`cost limit reached ($${spent.toFixed(4)} of $${options.maxCostUsd.toFixed(2)}); stopping`);
      return outcomes;
    }

    if (options.maxTasks !== undefined && options.maxTasks > 0 && outcomes.length >= options.maxTasks) {
      return outcomes;
    }
  }

  return outcomes;
}

/** Kills the whole process tree, not just the shell we spawned. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or not ours to signal.
  }
}

/** Substitutes `{{task_id}}` and `{{task_depth}}` only. */
function expandCommand(exec: string, task: AgentTask): string {
  return exec.replaceAll('{{task_id}}', task.id).replaceAll('{{task_depth}}', String(task.depth));
}

/** Executors report spend as "custo=$0.1234"; absent means the runner cannot budget. */
function readCost(output: string): number | undefined {
  const match = /custo=\$([0-9.]+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

function summarise(outcome: RunOutcome): string {
  const head = `exit ${outcome.exitCode ?? 'n/a'}`;
  const tail = outcome.output.split('\n').filter(Boolean).slice(-3).join(' | ');
  return tail ? `${head}: ${tail}` : head;
}
