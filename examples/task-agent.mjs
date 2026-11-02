#!/usr/bin/env node
/** Reference executor for `agent-memory run`. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cmd = process.env.TASK_AGENT_CMD;
const cli = process.env.TASK_AGENT_CLI ?? 'agent-memory';
const delegate = process.env.TASK_AGENT_DELEGATE === '1';

const title = process.env.AGENT_TASK_TITLE ?? '';
const detail = process.env.AGENT_TASK_DETAIL ?? '';
const pointer = process.env.AGENT_TASK_POINTER ?? '';
const taskId = process.env.AGENT_TASK_ID ?? 'unknown';
const depth = Number(process.env.AGENT_TASK_DEPTH ?? '0');
const agent = process.env.AGENT_ID ?? 'unknown';
const root = process.env.AGENT_MEMORY_ROOT ?? process.cwd();

const log = message => console.log(`[${agent}|d${depth}] ${message}`);

if (!cmd) {
  console.error('Set TASK_AGENT_CMD to the agent CLI, e.g. "claude -p" or "ollama run llama3.1:8b".');
  process.exit(2);
}
if (!title) {
  console.error('No task in the environment. This script is meant to be launched by `agent-memory run`.');
  process.exit(2);
}

/** Removes terminal control sequences. */
function stripAnsi(text) {
  return text
    .replace(/\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\][^]*/g, '')
    .replace(/[⠀-⣿]/g, '') // braille spinner frames
    .split('\n')
    // A carriage return means the terminal redrew the line, so only what follows the last one
    // survived on screen.
    .map(line => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

/** Runs the configured agent CLI with `prompt` on stdin and returns its stdout. */
function askAgent(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd: root, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve(stripAnsi(out).trim())
        : reject(new Error(`${cmd} exited ${code}: ${stripAnsi(err).trim().slice(0, 300)}`))
    );
    child.stdin.end(prompt);
  });
}

const context = [`TASK: ${title}`, detail && `DETAILS: ${detail}`, pointer && `CODE: ${pointer}`]
  .filter(Boolean)
  .join('\n');

try {
  await mkdir(path.join(root, 'outputs'), { recursive: true });

  // Only a top-level task is considered for splitting; a child just does the work.
  if (delegate && depth === 0) {
    const plan = await askAgent(
      [
        'Decide whether this task must be split into smaller tasks.',
        'Answer with at most 3 subtasks, one per line, each a short imperative sentence.',
        'If it is already small enough, answer exactly NONE.',
        '',
        context
      ].join('\n')
    );

    const subtasks = plan
      .split('\n')
      .map(line => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
      .filter(line => line.length > 8 && !/^none$/i.test(line))
      .slice(0, 3);

    if (subtasks.length > 0) {
      log(`delegating ${subtasks.length} subtask(s)`);
      for (const subtask of subtasks) {
        // --parent lets the queue assign depth and refuse anything past maxTaskDepth.
        await runCli(['--root', '.', 'task', 'create', '--agent', agent, '--title', subtask, '--parent', taskId]);
        log(`queued: ${subtask}`);
      }
      await writeFile(
        path.join(root, 'outputs', `${taskId}-plan.md`),
        `# ${title}\n\nDelegated:\n${subtasks.map(s => `- ${s}`).join('\n')}\n`,
        'utf8'
      );
      process.exit(0);
    }
    log('judged atomic; doing it directly');
  }

  const answer = await askAgent(
    ['Complete this task. Answer with the deliverable only, no preamble.', '', context].join('\n')
  );

  if (!answer) {
    console.error('the agent returned nothing');
    process.exit(1);
  }

  const file = path.join(root, 'outputs', `${taskId}.md`);
  await writeFile(file, `# ${title}\n\n${answer}\n`, 'utf8');
  log(`wrote outputs/${taskId}.md (${answer.length} chars)`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    // The CLI may be a bare command on PATH or "node dist/cli/main.js"; split on spaces.
    const [program, ...prefix] = cli.split(/\s+/);
    const child = spawn(program, [...prefix, ...args], { cwd: root, windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cli} exited ${code}`))));
  });
}
