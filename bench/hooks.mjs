#!/usr/bin/env node
/**
 * How long one Claude Code hook call takes, process start included, as the editor runs it.
 *
 *   npm run build && node bench/hooks.mjs [--runs 30] [--cli dist/cli/main.js[,other/main.js]]
 *
 * Each case calls `node <cli> hook claude <event>` with the JSON Claude Code sends on stdin. Before
 * timing, it checks that the hooks really work: a branch switch by one session over another
 * session's fresh shell-written change must exit 2. Several --cli paths are timed in turns, so a
 * busy machine slows them alike.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(flag('runs', '30'));
const CLIS = flag('cli', path.join(ROOT, 'dist', 'cli', 'main.js')).split(',').map(p => path.resolve(p));

// The hooks must act as the session in the JSON, against local files.
const ENV = { ...process.env };
for (const name of ['AGENT_MEMORY_AGENT', 'AGENT_MEMORY_REMOTE', 'AGENT_MEMORY_TOKEN']) delete ENV[name];

const GIT = ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

function hook(cli, event, payload) {
  const start = performance.now();
  const out = spawnSync(process.execPath, [cli, 'hook', 'claude', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: ENV,
    windowsHide: true
  });
  return { ms: performance.now() - start, code: out.status, stderr: out.stderr };
}

/** A memory root with one git checkout, `app`, holding one committed file. */
async function workspace(cli) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-hooks-'));
  execFileSync(process.execPath, [cli, 'init', '--root', root, '--name', 'Hooks bench'], { env: ENV });
  const app = path.join(root, 'app');
  await mkdir(path.join(app, 'src'), { recursive: true });
  const file = path.join(app, 'src', 'a.cs');
  await writeFile(file, 'class A {}\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: app });
  execFileSync('git', [...GIT, 'add', '-A'], { cwd: app });
  execFileSync('git', [...GIT, 'commit', '-q', '-m', 'start'], { cwd: app });
  return { root, app, file };
}

const shell = (session, cwd, command) => ({ session_id: session, cwd, tool_name: 'Bash', tool_input: { command } });
const edit = (session, cwd, file) => ({ session_id: session, cwd, tool_name: 'Edit', tool_input: { file_path: file, old_string: '{}', new_string: '{ }' } });

/** Session A writes a file through the shell; session B's branch switch over it must be refused. */
async function assertGuardWorks(cli) {
  const { root, app, file } = await workspace(cli);
  try {
    const write = shell('session-a', app, 'printf x > src/a.cs');
    const steps = [
      ['session-start', { session_id: 'session-a', cwd: app }, 0],
      ['pre-shell', write, 0]
    ];
    for (const [event, payload, expected] of steps) {
      const { code, stderr } = hook(cli, event, payload);
      if (code !== expected) throw new Error(`${event} exited ${code}, expected ${expected}: ${stderr}`);
    }
    await writeFile(file, 'class A { int changed; }\n');
    const after = hook(cli, 'post-shell', write);
    if (after.code !== 0) throw new Error(`post-shell exited ${after.code}: ${after.stderr}`);
    const blocked = hook(cli, 'pre-shell', shell('session-b', app, 'git switch -c x'));
    if (blocked.code !== 2 || !/src\/a\.cs/.test(blocked.stderr)) {
      throw new Error(`the guard did not block the branch switch (exit ${blocked.code}): ${blocked.stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const CASES = [
  ['session-start', w => ['session-start', { session_id: 'bench', cwd: w.app }]],
  ['pre-shell git status', w => ['pre-shell', shell('bench', w.app, 'git status')]],
  ['post-shell git status', w => ['post-shell', shell('bench', w.app, 'git status')]],
  ['pre-shell git switch -c x', w => ['pre-shell', shell('bench', w.app, 'git switch -c x')]],
  ['pre-write Edit', w => ['pre-write', edit('bench', w.app, w.file)]],
  ['post-write Edit', w => ['post-write', edit('bench', w.app, w.file)]]
];

const median = xs => quantile(xs, 0.5);
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
const round = n => Math.round(n);

for (const cli of CLIS) await assertGuardWorks(cli);

const runs = await Promise.all(CLIS.map(async cli => ({ cli, w: await workspace(cli), times: CASES.map(() => []) })));
try {
  for (const run of runs) {
    // A second session in the same checkout, as in real use; it has changed nothing, so nothing is blocked.
    hook(run.cli, 'session-start', { session_id: 'other', cwd: run.w.app });
    hook(run.cli, 'pre-shell', shell('other', run.w.app, 'git log -1'));
    // One untimed round registers the session and warms the disk cache.
    for (const [, make] of CASES) hook(run.cli, ...make(run.w));
  }
  for (let i = 0; i < RUNS; i++) {
    for (const [c, [name, make]] of CASES.entries()) {
      for (const run of runs) {
        const { ms, code, stderr } = hook(run.cli, ...make(run.w));
        if (code !== 0) throw new Error(`${name} exited ${code}: ${stderr}`);
        run.times[c].push(ms);
      }
    }
  }
} finally {
  for (const run of runs) await rm(run.w.root, { recursive: true, force: true });
}

console.log(`Node ${process.version}, ${os.platform()} ${os.release()}, ${RUNS} runs per case (ms, process start included)\n`);
const width = Math.max(...CASES.map(([name]) => name.length));
console.log(`${'case'.padEnd(width)}  ${runs.map((_, i) => `cli ${i + 1} median / p90`.padStart(22)).join('')}`);
for (const [c, [name]] of CASES.entries()) {
  const cells = runs.map(run => `${round(median(run.times[c]))} / ${round(quantile(run.times[c], 0.9))}`.padStart(22));
  console.log(`${name.padEnd(width)}  ${cells.join('')}`);
}
runs.forEach((run, i) => console.log(`cli ${i + 1}: ${run.cli}`));
