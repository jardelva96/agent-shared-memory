#!/usr/bin/env node
/** Executor that runs a Claude Code agent per task, joined to the shared memory. */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const agent = process.env.AGENT_ID ?? '';
const taskId = process.env.AGENT_TASK_ID ?? '';
const title = process.env.AGENT_TASK_TITLE ?? '';
const detail = process.env.AGENT_TASK_DETAIL ?? '';
const pointer = process.env.AGENT_TASK_POINTER ?? '';
const root = process.env.AGENT_MEMORY_ROOT ?? process.cwd();
const cli = process.env.CLAUDE_AGENT_CLI ?? 'agent-memory';

if (!agent || !title) {
  console.error('No task in the environment. Launch this through `agent-memory run`.');
  process.exit(2);
}

const log = message => console.log(`[${agent}] ${message}`);

// Written to a file rather than passed as a JSON string: an inline argument would have to
// survive cmd.exe and sh quoting rules, and the config contains paths that may have spaces.
const configDir = path.join(root, '.agents', 'mcp');
const configFile = path.join(configDir, `${agent}.json`);
await mkdir(configDir, { recursive: true });

// CLAUDE_AGENT_CLI is either a command on PATH ("agent-memory") or a program plus
// arguments ("node /path/to/main.js"); both have to become command + args.
const [command, ...prefix] = cli.split(/\s+/);
const serverArgs = [...prefix, 'mcp', '--root', root, '--agent', agent];

await writeFile(
  configFile,
  JSON.stringify({ mcpServers: { 'agent-memory': { command, args: serverArgs } } }, null, 2),
  'utf8'
);

const tools = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  // The whole memory server: status, record, inbox, task tools.
  'mcp__agent-memory',
  ...(process.env.CLAUDE_AGENT_BASH === '1' ? ['Bash'] : []),
  ...(process.env.CLAUDE_AGENT_TOOLS ? process.env.CLAUDE_AGENT_TOOLS.split(/\s+/) : [])
].filter(Boolean);

const protocol = [
  `You are ${agent}, one of several agents working in this repository at the same time.`,
  'The agent-memory MCP server is your shared operational memory. Follow this cycle:',
  '1. memory_status first: see who is touching what. Pass the file you plan to edit as `pointer`.',
  '2. memory_record type=INTENT before changing code, naming the exact file and symbol and why.',
  '3. Make only the change you announced.',
  '4. memory_record type=CHANGED (or CREATED/TESTING) immediately after, with the real result.',
  'If an overlap is reported, do not undo the other agent work: adjust to coexist, or record',
  'type=WAITING naming them. Use semantic pointers "file::symbol", never line numbers.',
  'Report honestly: if something failed, say so rather than claiming success.'
].join('\n');

const prompt = [
  `TASK ${taskId}: ${title}`,
  detail && `DETAILS: ${detail}`,
  pointer && `CODE: ${pointer}`,
  '',
  'Do the work now. When finished, answer with a one-line summary of what changed.'
]
  .filter(Boolean)
  .join('\n');

const args = [
  '-p',
  // JSON output carries the token counts and the cost.
  '--output-format',
  'json',
  '--mcp-config',
  configFile,
  '--strict-mcp-config',
  '--allowedTools',
  ...tools,
  '--append-system-prompt',
  protocol,
  ...(process.env.CLAUDE_AGENT_MODEL ? ['--model', process.env.CLAUDE_AGENT_MODEL] : [])
];

log(`starting ${taskId}: ${title}`);
const started = Date.now();

const exitCode = await new Promise(resolve => {
  // shell:true because `claude` is a .cmd shim on Windows and cannot be spawned directly.
  const child = spawn('claude', args, { shell: true, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => (out += chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', error => {
    console.error(`could not start claude: ${error.message}`);
    resolve(1);
  });
  child.on('close', code => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const report = summarise(out);
    // Printed on stdout so the runner stores the cost with the task result.
    console.log(report.answer);
    log(`${seconds}s | ${report.usage}`);
    resolve(report.failed ? 1 : code ?? 1);
  });
  child.stdin.end(prompt);
});

await rm(configFile, { force: true });
process.exit(exitCode);

/** Pulls the answer and the cost out of the JSON envelope, tolerating a non-JSON crash. */
function summarise(raw) {
  try {
    const json = JSON.parse(raw.trim());
    const u = json.usage ?? {};
    const inTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cost = json.total_cost_usd ?? 0;
    return {
      answer: String(json.result ?? '').trim(),
      usage: `in=${inTokens} out=${u.output_tokens ?? 0} turns=${json.num_turns ?? '?'} custo=$${cost.toFixed(4)}`,
      failed: json.is_error === true
    };
  } catch {
    return { answer: raw.trim().slice(-500), usage: 'usage indisponivel', failed: false };
  }
}
