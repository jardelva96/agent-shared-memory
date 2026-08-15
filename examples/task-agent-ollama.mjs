#!/usr/bin/env node
/**
 * Executor for `agent-memory run` backed by a local Ollama model.
 *
 * This talks to the Ollama HTTP API rather than the `ollama run` CLI on purpose. That
 * command renders for a terminal — spinner frames, cursor moves, line redraws — and a
 * pipe captures all of it, so the "deliverable" ends up with fragments of half-drawn
 * lines spliced into the text. The API returns the completion and nothing else.
 *
 * The same reasoning applies to any agent CLI that animates its output: prefer its
 * non-interactive mode or its API. `examples/task-agent.mjs` is the generic version for
 * CLIs that are designed to be piped (`claude -p`, for instance).
 *
 * Usage:
 *   agent-memory run --agent WORKER --exec "node examples/task-agent-ollama.mjs"
 *
 * Environment:
 *   OLLAMA_MODEL  model tag (default llama3.1:8b)
 *   OLLAMA_HOST   base URL (default http://127.0.0.1:11434)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const title = process.env.AGENT_TASK_TITLE ?? '';
const detail = process.env.AGENT_TASK_DETAIL ?? '';
const pointer = process.env.AGENT_TASK_POINTER ?? '';
const taskId = process.env.AGENT_TASK_ID ?? 'unknown';
const agent = process.env.AGENT_ID ?? 'unknown';
const root = process.env.AGENT_MEMORY_ROOT ?? process.cwd();

if (!title) {
  console.error('No task in the environment. Launch this through `agent-memory run`.');
  process.exit(2);
}

const prompt = [
  'Complete this task. Answer with the deliverable only, no preamble.',
  '',
  `TASK: ${title}`,
  detail && `DETAILS: ${detail}`,
  pointer && `CODE: ${pointer}`
]
  .filter(Boolean)
  .join('\n');

console.log(`[${agent}] ${taskId} -> ${model}`);
const started = Date.now();

let answer;
try {
  const call = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2 } })
  });
  if (!call.ok) throw new Error(`ollama returned ${call.status}`);
  answer = ((await call.json()).response ?? '').trim();
} catch (error) {
  // A non-zero exit tells the queue to mark the task FAILED and keep the reason.
  console.error(`inference failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!answer) {
  console.error('the model returned nothing');
  process.exit(1);
}

await mkdir(path.join(root, 'outputs'), { recursive: true });
await writeFile(path.join(root, 'outputs', `${taskId}.md`), `# ${title}\n\n${answer}\n`, 'utf8');
console.log(`[${agent}] wrote outputs/${taskId}.md in ${((Date.now() - started) / 1000).toFixed(1)}s`);
