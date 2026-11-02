/**
 * The tool loop every benchmark agent runs, so the conditions differ only in what they set.
 *
 * Conditions are compared on the same questions, the same models, the same system prompt
 * and the same turn budget. What changes is which tools exist: an agent that can only read
 * whole files against one that can also read a pointer. Anything else that differed would
 * be measured along with it.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chat } from './llm.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { extractSymbol } = await import(pathToFileURL(path.join(here, '..', 'dist', 'core', 'extract.js')).href);

/** Large enough never to bite on these files: a truncated read would flatter the baseline. */
const MAX_READ = 400_000;

export const TOOL_DEFS = {
  read_pointer: {
    type: 'function',
    function: {
      name: 'read_pointer',
      description:
        'Read only the code a pointer names, "file::symbol". Returns that symbol alone, not the whole file. ' +
        'A constant or helper used inside it can be read the same way with its own name.',
      parameters: {
        type: 'object',
        properties: { pointer: { type: 'string', description: 'Like "src/core/config.ts::DEFAULT_CONFIG".' } },
        required: ['pointer']
      }
    }
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a whole file.',
      parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
    }
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files in a directory.',
      parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] }
    }
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a whole file, replacing it if it exists.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string' }, content: { type: 'string' } },
        required: ['file', 'content']
      }
    }
  },
  answer: {
    type: 'function',
    function: {
      name: 'answer',
      description: 'Give the final answer and finish. Call this exactly once, at the end.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  }
};

function inside(root, candidate) {
  const base = path.resolve(root);
  const full = path.resolve(base, String(candidate ?? '').replace(/^\/+/, ''));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`outside the project: ${candidate}`);
  return full;
}

/** Tool implementations. `extra` lets a caller add its own (run_tests, finish_review...). */
export function makeTools(root, extra = {}) {
  return {
    async read_pointer({ pointer }) {
      const [file, ...rest] = String(pointer ?? '').split('::');
      const symbol = rest[0];
      const text = await readFile(inside(root, file), 'utf8');
      if (!symbol) return text.slice(0, MAX_READ);
      const found = extractSymbol(text, symbol);
      if (!found) return `Symbol "${symbol}" not found in ${file}. Read the file to check the spelling.`;
      return `${file}:${found.startLine}-${found.endLine} (${symbol})\n\n${found.text}`;
    },
    async read_file({ file }) {
      return (await readFile(inside(root, file), 'utf8')).slice(0, MAX_READ);
    },
    async list_files({ dir }) {
      return (await readdir(inside(root, dir ?? '.'))).slice(0, 200).join('\n');
    },
    async write_file({ file, content }) {
      const full = inside(root, file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, String(content ?? ''), 'utf8');
      return `wrote ${file} (${String(content ?? '').length} chars)`;
    },
    ...extra
  };
}

/**
 * Runs one agent to completion and returns what it cost and what it said.
 *
 * Usage is summed from the provider's own numbers on every call. Every call re-sends the
 * whole conversation, so a file read on turn 1 is paid for again on turns 2, 3 and 4 --
 * which is exactly the effect a per-call view would hide.
 */
export async function runAgent({ provider, model, system, user, toolNames, root, extraTools, maxTurns = 8, maxTokens = 2048, stopAfter = ['finish_review'], meta, log }) {
  const impl = makeTools(root, extraTools);
  const tools = toolNames.map(name => extraTools?.[`${name}__def`] ?? TOOL_DEFS[name]);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  const totals = { calls: 0, prompt: 0, completion: 0, total: 0, reasoning: 0, ms: 0, toolChars: 0, missingUsage: 0 };
  const toolCalls = [];
  let finalAnswer = null;
  let error = null;
  let turns = 0;

  try {
    while (turns < maxTurns && finalAnswer === null) {
      turns++;
      // Groq's free tier counts max_tokens against an 8,000 tokens-per-minute budget, so a
      // long conversation asking for the full 4,096 is refused before it is even read.
      const room = provider === 'groq' ? Math.floor(7600 - JSON.stringify(messages).length / 3.2) : maxTokens;
      const { message, usage, ms } = await chat({
        provider,
        model,
        messages,
        tools,
        maxTokens: Math.max(512, Math.min(maxTokens, room)),
        meta: { ...meta, turn: turns },
        log
      });
      totals.calls++;
      totals.ms += ms;
      if (usage.prompt_tokens == null) totals.missingUsage++;
      totals.prompt += usage.prompt_tokens ?? 0;
      totals.completion += usage.completion_tokens ?? 0;
      totals.total += usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      totals.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;

      const assistant = { ...message, role: 'assistant', content: message.content ?? '' };
      // Groq refuses its own reasoning field when it is sent back.
      if (provider === 'groq') delete assistant.reasoning;
      messages.push(assistant);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        // Prose and no tool: take it as the answer rather than spin to the ceiling.
        if (String(message.content ?? '').trim()) finalAnswer = String(message.content).trim();
        else error = 'resposta vazia';
        break;
      }

      for (const call of calls) {
        const name = call.function?.name;
        let args = call.function?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args || '{}');
          } catch {
            args = {};
          }
        }
        let result;
        if (name === 'answer') {
          finalAnswer = String(args.text ?? '');
          result = 'done';
        } else if (!toolNames.includes(name) || !impl[name]) {
          result = `unknown tool: ${name}`;
        } else {
          try {
            result = String(await impl[name](args));
          } catch (e) {
            result = `error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        totals.toolChars += result.length;
        toolCalls.push({ turn: turns, name, args: JSON.stringify(args).slice(0, 200), chars: result.length });
        messages.push({ role: 'tool', tool_call_id: call.id ?? `${name}-${turns}`, name, content: result });
        if (stopAfter.includes(name) && finalAnswer === null) finalAnswer = result;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (finalAnswer === null && !error) error = `sem resposta em ${turns} turnos`;
  return { answer: finalAnswer, error, turns, totals, toolCalls };
}
