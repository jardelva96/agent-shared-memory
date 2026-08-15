import { spawn } from 'node:child_process';
import { AgentMemoryService } from './service.js';
import { AgentTask } from '../models/types.js';
import { formatPointer } from './pointer.js';

export interface RunnerOptions {
  agentId: string;
  /** Shell command to run per task. Task content never enters this string. */
  exec: string;
  intervalMs?: number;
  /** Stop after this many tasks; 0 means run until interrupted. */
  maxTasks?: number;
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

/**
 * Executes one claimed task.
 *
 * The task reaches the command through environment variables only — never by string
 * substitution. A task title is written by another agent, so interpolating it into a
 * shell command would let queued text run as code.
 */
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
          // Settle now rather than waiting for `close`: the killed shell may leave a
          // grandchild holding the pipes open, which would block the runner for as long
          // as the hung command wanted to live — exactly what the timeout exists to stop.
          settle(null, 'timed out;');
        }, options.timeoutMs)
      : undefined;

    child.on('error', error => settle(null, `could not start: ${error.message}`));
    child.on('close', code => settle(code));
  });
}

/**
 * Claims and executes tasks until stopped. A crash between claim and finish leaves the
 * claim to expire, so the task returns to the pool instead of being lost.
 */
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
      if (options.maxTasks === undefined) return outcomes; // single sweep
      await new Promise(resolve => setTimeout(resolve, interval));
      continue;
    }

    log(`claimed ${task.id}: ${task.title}`);
    const outcome = await executeTask(service, task, options);
    // Recorded before finishing: a throw from finishTask (a lost claim, a contended
    // lock) must not discard work that already ran and already cost money.
    outcomes.push(outcome);

    try {
      await service.finishTask(task.id, outcome.status, summarise(outcome), options.agentId);
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

/**
 * Kills the whole process tree, not just the shell we spawned.
 *
 * With `shell: true` the direct child is cmd.exe or sh; killing it leaves the actual
 * command running as a grandchild, so a hung task would survive its own timeout.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or we lost the right to signal it; nothing else to do.
  }
}

/**
 * Substitutes `{{task_id}}` and `{{task_depth}}` only.
 *
 * Both come from a validated charset, so they cannot carry shell syntax — which is why
 * they are safe to interpolate while the title, detail and pointer are not, and stay
 * available only through the environment. This also avoids the portability trap of
 * writing `$AGENT_TASK_ID` in a command that runs under cmd.exe on Windows.
 */
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
