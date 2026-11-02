#!/usr/bin/env node
/**
 * The agent `agent-memory run` launches for one task in the multi-agent benchmark.
 *
 * Same tool loop as the token benchmark, pointed at a real queue: the task arrives through
 * the runner's environment, the agent reads and writes the sandbox, records what it is doing
 * in the shared memory (so the others see it), and a reviewer closes its review through the
 * same service the CLI uses. The provider and model come from BENCH_PROVIDER/BENCH_MODEL, so
 * four runners with four models make four different agents on one repository.
 *
 * BENCH_COND=sem_memoria removes the `record` tool: the agents work blind to each other,
 * which is the baseline the coordination is measured against.
 *
 * Exit codes: 0 work delivered (or verdict recorded), 1 nothing delivered, 3 a reviewer that
 * gave no verdict (requeued by the runner), 75 daily quota -- the orchestrator stops this agent.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgent, TOOL_DEFS } from './agente.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { AgentMemoryService } = await import(pathToFileURL(path.join(here, '..', 'dist', 'core', 'service.js')).href);

const env = process.env;
const agent = env.AGENT_ID;
const root = env.AGENT_MEMORY_ROOT;
const taskId = env.AGENT_TASK_ID;
const provider = env.BENCH_PROVIDER;
const model = env.BENCH_MODEL;
const cond = env.BENCH_COND ?? 'solo';
const service = new AgentMemoryService(root);

const task = JSON.parse(await readFile(path.join(root, '.agents', 'tasks', `${taskId}.json`), 'utf8'));
const isReview = Boolean(task.reviewOf);
const work = isReview ? JSON.parse(await readFile(path.join(root, '.agents', 'tasks', `${task.reviewOf}.json`), 'utf8')) : task;
const file = work.pointer?.file;
const testName = String(work.title).match(/\[(\w+)\]/)?.[1];

let verdict = null;
let wrote = false;
const conflictsSeen = [];

function runTests() {
  return new Promise(resolve => {
    const target = testName ? [`tests/visiveis/${testName}.test.js`] : ['tests/visiveis/'];
    execFile(process.execPath, ['--test', ...target], { cwd: root, timeout: 30_000 }, (error, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`.replace(/\r/g, '');
      const failing = out.split('\n').filter(l => /not ok|✖|AssertionError|Error:|expected|actual/.test(l)).slice(0, 25);
      const summary = out.split('\n').filter(l => /^ℹ (tests|pass|fail)/.test(l)).join(' | ');
      resolve(`${error ? 'FALHOU' : 'PASSOU'} ${summary}\n${failing.join('\n')}`.slice(0, 3000));
    });
  });
}

const extra = {
  run_tests: async () => runTests(),
  run_tests__def: {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the visible tests for this task and return the result.',
      parameters: { type: 'object', properties: {} }
    }
  },
  write_file: async ({ file: target, content }) => {
    const full = path.resolve(root, String(target ?? ''));
    if (!full.startsWith(path.resolve(root) + path.sep)) return 'error: outside the project';
    if (/[\\/]tests[\\/]/.test(full)) return 'error: tests are read-only';
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, String(content ?? ''), 'utf8');
    wrote = true;
    return `wrote ${target}`;
  },
  record: async ({ type, message, file: target }) => {
    const result = await service.activity({
      agentId: agent,
      type: String(type ?? 'NOTE').toUpperCase(),
      description: String(message ?? '').slice(0, 400),
      task: work.id,
      pointer: target ? { file: String(target) } : undefined
    });
    if (!result.conflicts?.length) return 'recorded; no other agent is on this file right now';
    conflictsSeen.push(...result.conflicts.map(c => c.agentId ?? c.otherAgentId ?? JSON.stringify(c).slice(0, 60)));
    const lines = result.conflicts.map(c => `- ${c.agentId ?? c.otherAgentId}: ${c.description ?? c.message ?? JSON.stringify(c).slice(0, 160)}`);
    return `recorded. WARNING, other agents are working on the same file right now:\n${lines.join('\n')}\nRe-read the file right before writing and keep their code.`;
  },
  record__def: {
    type: 'function',
    function: {
      name: 'record',
      description:
        'Record in the shared memory what you are doing, so the other agents see it. INTENT before writing a file, CHANGED after. ' +
        'The answer tells you if another agent is working on the same file.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['INTENT', 'CHANGED', 'FOUND', 'NOTE'] },
          message: { type: 'string' },
          file: { type: 'string' }
        },
        required: ['type', 'message', 'file']
      }
    }
  },
  finish_review: async ({ approve, reason }) => {
    verdict = { approve: Boolean(approve), reason: String(reason ?? '') };
    return 'verdict recorded';
  },
  finish_review__def: {
    type: 'function',
    function: {
      name: 'finish_review',
      description: 'Give the verdict. approve=false sends the work back to the queue with your reason. Call exactly once.',
      parameters: {
        type: 'object',
        properties: { approve: { type: 'boolean' }, reason: { type: 'string', description: 'Concrete: what is wrong, or why it is right.' } },
        required: ['approve', 'reason']
      }
    }
  }
};

// Two ways of stopping an agent from writing over a newer file, measured against each other.
//   aviso -- the shared memory's notices reach the agent before its next write, the way a
//            pre-write hook would surface them: unread messages are shown, and a write with
//            unread notices pending is held once so the agent can re-read.
//   trava -- no shared memory at all; the write is refused if the file changed since this
//            agent last read it (what an editor tool with a stale-read check does).
const memoryOn = cond !== 'sem_memoria' && cond !== 'trava';

// The symbol tools, called the way the MCP server calls them.
const { editSymbol, outlineSymbols } = await import(pathToFileURL(path.join(here, '..', 'dist', 'core', 'symbols.js')).href);
const symbolEdit = mode => async ({ pointer, code }) => {
  try {
    const result = await editSymbol(root, String(pointer ?? ''), String(code ?? ''), mode);
    wrote = true;
    await service
      .activity({ agentId: agent, type: 'CHANGED', description: `${mode} ${result.symbol}`, task: work.id, pointer: { file: result.file, symbol: result.symbol } })
      .catch(() => undefined);
    return `${mode === 'replace' ? 'Replaced' : 'Inserted'} at ${result.file} lines ${result.fromLine}-${result.toLine}.`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
};
const pointerArgs = {
  type: 'object',
  properties: {
    pointer: { type: 'string', description: '"file::symbol"' },
    code: { type: 'string', description: 'The complete new code of the symbol.' }
  },
  required: ['pointer', 'code']
};
Object.assign(extra, {
  replace_symbol: symbolEdit('replace'),
  replace_symbol__def: { type: 'function', function: { name: 'replace_symbol', description: 'Replace one function or class in place. The file is re-read at the moment of the edit.', parameters: pointerArgs } },
  insert_symbol: symbolEdit('insert_after'),
  insert_symbol__def: { type: 'function', function: { name: 'insert_symbol', description: 'Insert new code right after an existing symbol.', parameters: pointerArgs } },
  list_symbols: async ({ file: target }) => {
    const source = await readFile(path.resolve(root, String(target ?? '')), 'utf8');
    return outlineSymbols(source, String(target)).map(e => `${e.declarationLine}-${e.endLine} ${e.kind} ${e.name}`).join('\n') || 'nothing declared';
  },
  list_symbols__def: { type: 'function', function: { name: 'list_symbols', description: 'List what a file declares, with line ranges.', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } } }
});
const lastRead = new Map();
const digest = text => String(text.length) + ':' + [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const readCurrent = async target => readFile(path.resolve(root, String(target ?? '')), 'utf8').catch(() => null);

if (cond === 'trava' || cond === 'aviso') {
  const remember = async target => {
    const now = await readCurrent(target);
    if (now !== null) lastRead.set(path.resolve(root, String(target)), digest(now));
  };
  extra.read_file = async args => {
    await remember(args.file);
    return (await readCurrent(args.file)) ?? `error: cannot read ${args.file}`;
  };
  const plainWrite = extra.write_file;
  // A refused write hands back the file as it is now. The first race showed agents told to
  // "read it again" retrying the write instead, until they ran out of turns.
  const refuse = async (why, target) => {
    const now = await readCurrent(target);
    await remember(target);
    return `${why}\nWrite NOT done. ${target} as it is NOW (keep the other agent's code and add yours):\n\n${now ?? ''}`;
  };
  extra.write_file = async args => {
    if (cond === 'trava') {
      const full = path.resolve(root, String(args.file ?? ''));
      const now = await readCurrent(args.file);
      if (now !== null && lastRead.get(full) !== digest(now)) {
        return refuse(`error: ${args.file} changed since you last read it (or you never read it whole).`, args.file);
      }
      const result = await plainWrite(args);
      const after = await readCurrent(args.file);
      if (after !== null) lastRead.set(full, digest(after));
      return result;
    }
    // aviso: the pre-write hook shows pending notices and holds the write once...
    const notices = await pendingNotices();
    if (notices) return refuse(notices, args.file);
    const result = await plainWrite(args);
    // ...and the post-write hook records the change, which tells everyone else on the file
    // that their copy is stale -- without waiting for the agent to remember to say so.
    await service
      .activity({ agentId: agent, type: 'CHANGED', description: `wrote ${args.file}`, task: work.id, pointer: { file: String(args.file) } })
      .catch(() => undefined);
    return result;
  };
}

async function pendingNotices() {
  if (cond !== 'aviso') return '';
  if ((await service.messages.unreadCount(agent)) === 0) return '';
  const { unread } = await service.readInbox(agent);
  return unread.map(m => `MESSAGE from ${m.from}: ${m.body}`).join('\n');
}

const spec = String(work.detail ?? '');
let system;
let user;
let toolNames;

if (isReview) {
  system = [
    `You are ${agent}, a code reviewer in a team of agents sharing one repository.`,
    'Another agent implemented the task below. Judge it against the specification, not against your taste:',
    'read the code, run the visible tests, and check the rules of the spec one by one, including edge cases the visible tests do not cover.',
    'Then call finish_review exactly once: approve=true if it meets the spec, approve=false with the concrete defect otherwise.'
  ].join('\n');
  user = `TASK UNDER REVIEW: ${work.title}\nFILE: ${file}\n\nSPECIFICATION:\n${spec}`;
  toolNames = ['read_pointer', 'read_file', 'list_files', 'run_tests', 'finish_review'];
} else {
  system = [
    `You are ${agent}, a coding agent in a team of agents working on the same repository at the same time.`,
    'Implement the task exactly as specified, in JavaScript (ES modules).',
    !memoryOn
      ? 'Steps: read the current file, write the whole file with write_file, run_tests, fix until they pass, then call answer.'
      : 'Steps: read the current file; call record INTENT with the file BEFORE writing; write the whole file with write_file ' +
        '(keep any code in it that is not yours); run_tests; fix until they pass; record CHANGED; then call answer.',
    'The visible tests are only examples: the spec has more rules, and hidden tests check all of them.'
  ].join('\n');
  user = `TASK: ${work.title}\nFILE: ${file}\n\nSPECIFICATION:\n${spec}`;
  toolNames = ['read_pointer', 'read_file', 'list_files', 'write_file', 'run_tests', ...(memoryOn ? ['record'] : []), 'answer'];
  if (cond.startsWith('simbolo')) {
    // The version that ships now: the agent changes its function by symbol and never
    // rewrites the file, so a stale copy has nothing to overwrite.
    system = [
      `You are ${agent}, a coding agent in a team of agents working on the same repository at the same time.`,
      'Implement the task exactly as specified, in JavaScript (ES modules).',
      `Steps: read your function with read_pointer "${file}::${work.pointer?.symbol ?? ''}"; replace it with replace_symbol ` +
        '(give the complete function, from its signature to its closing brace; helpers can go inside it or be added with ' +
        'insert_symbol); run_tests; fix until they pass; then call answer. You cannot rewrite whole files.',
      'The visible tests are only examples: the spec has more rules, and hidden tests check all of them.'
    ].join('\n');
    toolNames = ['read_pointer', 'list_symbols', 'replace_symbol', 'insert_symbol', 'run_tests', 'answer'];
  }
}

if (memoryOn) {
  await service.heartbeat(agent).catch(() => undefined);
}

// In `aviso`, every tool result carries any notice that arrived meanwhile, as a hook would.
if (cond === 'aviso') {
  for (const name of ['read_file', 'read_pointer', 'list_files', 'run_tests', 'record']) {
    const base = extra[name];
    if (!base) continue;
    extra[name] = async args => {
      const result = await base(args);
      const notices = await pendingNotices();
      return notices ? `${result}\n\n${notices}` : result;
    };
  }
}

const started = Date.now();
const r = await runAgent({
  provider,
  model,
  system,
  user,
  toolNames,
  root,
  extraTools: extra,
  maxTurns: 14,
  maxTokens: 4096,
  meta: { exp: 'multiagente', cond, agent, task: taskId, work: work.id, review: isReview },
  log: env.BENCH_LOG
});

const record = {
  ts: new Date().toISOString(),
  cond,
  agent,
  provider,
  model,
  task: taskId,
  work: work.id,
  workKey: testName,
  review: isReview,
  round: task.reviewRound ?? null,
  verdict,
  wrote,
  conflictsSeen,
  turns: r.turns,
  ...r.totals,
  wallMs: Date.now() - started,
  error: r.error,
  tools: r.toolCalls.map(t => t.name)
};
await writeFile(env.BENCH_RUNS, `${JSON.stringify(record)}\n`, { flag: 'a' });

if (/daily quota/.test(r.error ?? '')) {
  await writeFile(path.join(env.BENCH_QUOTA_DIR, `${agent}.quota`), r.error);
  console.error(`COTA: ${r.error}`);
  process.exit(75);
}

if (isReview) {
  if (!verdict) {
    console.error(`revisor sem veredito: ${r.error ?? 'nao chamou finish_review'}`);
    process.exit(3);
  }
  await service.finishTask(taskId, verdict.approve ? 'DONE' : 'FAILED', verdict.reason.slice(0, 500), agent);
  console.log(`${verdict.approve ? 'APROVOU' : 'REJEITOU'}: ${verdict.reason.slice(0, 200)}`);
  process.exit(0);
}

if (!wrote) {
  console.error(`nada entregue: ${r.error ?? 'nao escreveu o arquivo'}`);
  process.exit(1);
}
console.log(r.answer ?? 'entregue');
process.exit(0);
