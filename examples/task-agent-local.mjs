#!/usr/bin/env node
/**
 * A local model acting as a real agent: it reads files, edits them and records its work
 * in the shared memory by calling tools, rather than emitting one blob of text.
 *
 * `task-agent-ollama.mjs` asks for a completion and writes the answer to a file. That is
 * fine for prose, but it cannot look at the code before changing it, and it never appears
 * in the panel. This one runs the tool loop against Ollama's chat API, so a local model
 * participates on the same terms as a Claude agent — just with a smaller budget of
 * competence, which is the point of routing cheap work here.
 *
 * Usage:
 *   OLLAMA_MODEL=glm-4.7-flash agent-memory run --agent L1 --exec "node examples/task-agent-local.mjs"
 *
 * Environment:
 *   OLLAMA_MODEL     model tag (default glm-4.7-flash)
 *   OLLAMA_HOST      base URL (default http://127.0.0.1:11434)
 *   LOCAL_MAX_TURNS  tool-loop ceiling (default 12) — a small model can loop forever
 *   LOCAL_WRITE      "1" to allow write_file; read-only by default
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const model = process.env.OLLAMA_MODEL ?? 'glm-4.7-flash';
const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const maxTurns = Number(process.env.LOCAL_MAX_TURNS ?? '12');
const mayWrite = process.env.LOCAL_WRITE === '1';

const agent = process.env.AGENT_ID ?? 'LOCAL';
const taskId = process.env.AGENT_TASK_ID ?? 'unknown';
const title = process.env.AGENT_TASK_TITLE ?? '';
const detail = process.env.AGENT_TASK_DETAIL ?? '';
const pointer = process.env.AGENT_TASK_POINTER ?? '';
const pointerFile = process.env.AGENT_TASK_POINTER_FILE ?? '';
const root = process.env.AGENT_MEMORY_ROOT ?? process.cwd();

if (!title) {
  console.error('No task in the environment. Launch this through `agent-memory run`.');
  process.exit(2);
}

const log = message => console.log(`[${agent}] ${message}`);

/** Keeps every path inside the project, whatever the model asks for. */
function resolveInside(candidate) {
  const full = path.resolve(root, candidate ?? '');
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`path escapes the project: ${candidate}`);
  }
  return full;
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_pointer',
      description:
        'Read only the code a pointer names: "file::symbol". Returns that symbol alone, not the whole file. ' +
        'Always try this before read_file — a small model that reads a whole file usually runs out of turns.',
      parameters: {
        type: 'object',
        properties: {
          pointer: { type: 'string', description: 'Like "src/core/config.ts::DEFAULT_CONFIG".' }
        },
        required: ['pointer']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a whole file. Prefer read_pointer when you know the symbol.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Project-relative path.' } },
        required: ['file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a project directory.',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Project-relative directory.' } },
        required: ['dir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record',
      description:
        'Record what you are doing in the shared memory so other agents can see it. ' +
        'Use INTENT before changing anything and CHANGED or FOUND after.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['INTENT', 'FOUND', 'CHANGED', 'NOTE'] },
          message: { type: 'string' },
          file: { type: 'string', description: 'File the record is about.' }
        },
        required: ['type', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'answer',
      description: 'Give the final answer and finish. Call this exactly once, at the end.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The deliverable.' } },
        required: ['text']
      }
    }
  },
  ...(mayWrite
    ? [
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write a file in the project, replacing it if it exists.',
            parameters: {
              type: 'object',
              properties: { file: { type: 'string' }, content: { type: 'string' } },
              required: ['file', 'content']
            }
          }
        }
      ]
    : [])
];

const { AgentMemoryService } = await import(
  new URL('../dist/core/service.js', import.meta.url).href
).catch(() => ({ AgentMemoryService: null }));

// Narrowing a file to one symbol is the whole reason a small model can answer at all here,
// so if the build is missing, read_pointer degrades to reading the file rather than failing.
const { extractSymbol } = await import(new URL('../dist/core/extract.js', import.meta.url).href).catch(
  () => ({ extractSymbol: () => undefined })
);
const { parsePointer } = await import(new URL('../dist/core/pointer.js', import.meta.url).href).catch(
  () => ({ parsePointer: value => ({ file: String(value).split('::')[0], symbol: String(value).split('::')[1] }) })
);

const service = AgentMemoryService ? new AgentMemoryService(root) : null;
let finalAnswer = null;

async function runTool(name, args) {
  switch (name) {
    case 'read_pointer': {
      const parsed = parsePointer(String(args.pointer ?? ''));
      if (!parsed?.file) return 'Not a pointer. Use "file::symbol".';
      const text = await readFile(resolveInside(parsed.file), 'utf8');
      if (!parsed.symbol) return text.length > 6000 ? `${text.slice(0, 6000)}\n...[truncado]` : text;
      const found = extractSymbol(text, parsed.symbol);
      // Truncation is what a whole-file read does to the answer; narrowing avoids needing it.
      if (!found) return `Symbol "${parsed.symbol}" not found in ${parsed.file}. Try read_file.`;
      return `${parsed.file}:${found.startLine}-${found.endLine}\n\n${found.text}`;
    }
    case 'read_file': {
      const file = resolveInside(args.file);
      const text = await readFile(file, 'utf8');
      // Truncated on purpose: a small model drowns in a long file and stops calling tools.
      return text.length > 6000 ? `${text.slice(0, 6000)}\n...[truncado]` : text;
    }
    case 'list_files': {
      const dir = resolveInside(args.dir);
      return (await readdir(dir)).slice(0, 100).join('\n');
    }
    case 'record': {
      if (!service) return 'shared memory unavailable';
      await service.activity({
        agentId: agent,
        type: args.type,
        description: String(args.message).slice(0, 500),
        pointer: args.file ? { file: String(args.file) } : undefined
      });
      return 'recorded';
    }
    case 'write_file': {
      const file = resolveInside(args.file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, String(args.content), 'utf8');
      return `wrote ${args.file}`;
    }
    case 'answer': {
      finalAnswer = String(args.text);
      return 'done';
    }
    default:
      return `unknown tool: ${name}`;
  }
}

/**
 * Finds tool calls a model wrote as text instead of emitting through the protocol.
 *
 * Smaller models routinely answer with prose plus `{"name": ..., "arguments": {...}}`
 * rather than populating `tool_calls`. The intent is unambiguous and the JSON is valid,
 * so refusing it would discard a correct decision over a formatting detail — and that
 * one detail is the difference between a local model being usable as an agent or not.
 */
function extractTextToolCalls(text, known) {
  if (!text) return [];
  const found = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    // Walk forward keeping brace depth, ignoring braces inside strings.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth !== 0) continue;

      try {
        const parsed = JSON.parse(text.slice(i, j + 1));
        const name = parsed.name ?? parsed.tool ?? parsed.function?.name;
        if (typeof name === 'string' && known.has(name)) {
          const args = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {};
          found.push({ function: { name, arguments: args } });
        }
      } catch {
        // Not a JSON object; keep scanning from the next brace.
      }
      i = j;
      break;
    }
  }
  return found;
}

const TOOL_NAMES = new Set(tools.map(t => t.function.name));

const messages = [
  {
    role: 'system',
    content: [
      `You are ${agent}, an agent working in a shared repository.`,
      'Use the tools. Read before you answer. Record INTENT before changing anything.',
      'When you have the deliverable, call `answer` — that is the only way to finish.',
      'Be brief. Do not guess file contents; read them.'
    ].join('\n')
  },
  {
    role: 'user',
    content: [
      `TASK ${taskId}: ${title}`,
      detail && `DETAILS: ${detail}`,
      pointer && `POINTER: ${pointer}`,
      pointerFile && `The answer is very likely inside: ${pointerFile}`
    ]
      .filter(Boolean)
      .join('\n')
  }
];

log(`starting ${taskId} with ${model}`);
const started = Date.now();
let turns = 0;

try {
  while (turns < maxTurns && finalAnswer === null) {
    turns++;
    const call = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.1 } })
    });
    if (!call.ok) throw new Error(`ollama returned ${call.status}`);

    const reply = (await call.json()).message;
    messages.push(reply);

    let calls = reply?.tool_calls ?? [];
    let fromText = false;
    if (calls.length === 0) {
      calls = extractTextToolCalls(reply?.content ?? '', TOOL_NAMES);
      fromText = calls.length > 0;
      if (fromText) log(`${calls.length} chamada(s) recuperada(s) do texto`);
    }

    if (calls.length === 0) {
      // No tool call and no answer: take the plain text as the deliverable rather than
      // looping until the ceiling, which is what a weak model tends to do here.
      if (reply?.content?.trim()) finalAnswer = reply.content.trim();
      break;
    }

    for (const toolCall of calls) {
      const name = toolCall.function?.name;
      let args = toolCall.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      let result;
      try {
        result = await runTool(name, args);
      } catch (error) {
        result = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
      log(`tool ${name}(${JSON.stringify(args).slice(0, 80)}) -> ${String(result).slice(0, 60).replace(/\s+/g, ' ')}`);
      messages.push({ role: 'tool', content: String(result).slice(0, 6000) });
    }
  }
} catch (error) {
  console.error(`local agent failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (finalAnswer === null) {
  console.error(`no answer after ${turns} turns (${seconds}s)`);
  process.exit(1);
}

console.log(finalAnswer);
log(`${seconds}s | turnos=${turns} | modelo=${model}`);
