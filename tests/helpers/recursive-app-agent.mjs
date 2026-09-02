import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.on('uncaughtException', error => {
  const root = process.env.AGENT_MEMORY_ROOT;
  if (root) {
    const appDir = path.join(root, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, 'agent-error.log'), error.stack ?? String(error));
  }
  throw error;
});

const root = process.env.AGENT_MEMORY_ROOT;
const agent = process.env.AGENT_ID;
const taskId = process.env.AGENT_TASK_ID;
const depth = Number(process.env.AGENT_TASK_DEPTH ?? '0');
const cli = process.env.AGENT_MEMORY_CLI;
const repo = process.env.AGENT_MEMORY_REPO ?? root;
const node = process.execPath;

if (!root || !agent || !taskId || !cli) {
  throw new Error('missing runner environment');
}

const appDir = path.join(root, 'app');
mkdirSync(appDir, { recursive: true });
mkdirSync(path.join(appDir, 'public'), { recursive: true });
mkdirSync(path.join(appDir, 'data'), { recursive: true });
mkdirSync(path.join(appDir, 'test'), { recursive: true });

const pieces = [
  [
    'package.json',
    JSON.stringify(
      {
        name: 'agent-built-fullstack',
        version: '1.0.0',
        type: 'module',
        private: true,
        scripts: {
          start: 'node server.js',
          test: 'node --test test/*.test.mjs'
        }
      },
      null,
      2
    ) + '\n'
  ],
  [
    'server.js',
    `import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(root, 'data', 'tasks.json');
const publicDir = path.join(root, 'public');

async function readTasks() {
  try {
    return JSON.parse(await readFile(dataFile, 'utf8'));
  } catch {
    return [];
  }
}

async function writeTasks(tasks) {
  await writeFile(dataFile, JSON.stringify(tasks, null, 2) + '\\n');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'agent-built-fullstack' });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      return sendJson(res, 200, await readTasks());
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await readBody(req);
      if (typeof input.title !== 'string' || !input.title.trim()) {
        return sendJson(res, 400, { error: 'title is required' });
      }
      const tasks = await readTasks();
      const task = { id: Date.now().toString(36), title: input.title.trim(), done: false };
      tasks.push(task);
      await writeTasks(tasks);
      return sendJson(res, 201, task);
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const input = await readBody(req);
      const tasks = await readTasks();
      const task = tasks.find(item => item.id === id);
      if (!task) return sendJson(res, 404, { error: 'not found' });
      if (typeof input.done === 'boolean') task.done = input.done;
      await writeTasks(tasks);
      return sendJson(res, 200, task);
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const target = path.normalize(path.join(publicDir, file));
    if (!target.startsWith(publicDir)) return sendJson(res, 403, { error: 'forbidden' });
    createReadStream(target)
      .on('error', () => sendJson(res, 404, { error: 'not found' }))
      .pipe(res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 0) || 3000;
  const server = await createServer();
  server.listen(port, () => console.log('listening ' + server.address().port));
}
`
  ],
  [
    'public/index.html',
    '<!doctype html><html><head><meta charset="utf-8"><title>Agent Ops</title><link rel="stylesheet" href="./styles.css"></head><body><main><section class="toolbar"><h1>Agent Ops</h1><form id="task-form"><input id="title" name="title" placeholder="Nova tarefa" required><button>Adicionar</button></form></section><ul id="tasks"></ul><p id="status"></p></main><script src="./app.js"></script></body></html>\n'
  ],
  [
    'public/app.js',
    `const list = document.querySelector('#tasks');
const form = document.querySelector('#task-form');
const status = document.querySelector('#status');

async function api(path, options) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function render(tasks) {
  list.replaceChildren(...tasks.map(task => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = task.done;
    box.addEventListener('change', async () => {
      await api('/api/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({ done: box.checked })
      });
      await load();
    });
    label.append(box, ' ' + task.title);
    item.append(label);
    return item;
  }));
}

async function load() {
  const health = await api('/api/health');
  status.textContent = health.ok ? 'online' : 'offline';
  render(await api('/api/tasks'));
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const title = new FormData(form).get('title');
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) });
  form.reset();
  await load();
});

load().catch(error => {
  status.textContent = error.message;
});
`
  ],
  [
    'public/styles.css',
    'body{font-family:system-ui;margin:0;background:#f4f6f8;color:#1f2937}main{max-width:760px;margin:48px auto;padding:0 20px}.toolbar{display:flex;gap:16px;align-items:center;justify-content:space-between}form{display:flex;gap:8px}input,button{font:inherit;padding:10px 12px;border:1px solid #b8c2cc;border-radius:6px}button{background:#2155d6;color:white;border-color:#2155d6}ul{padding:0;display:grid;gap:8px}li{list-style:none;background:white;border:1px solid #d7dde5;border-radius:8px;padding:12px}#status{color:#2f855a}\n'
  ],
  [
    'data/tasks.json',
    '[\n  {\n    "id": "seed",\n    "title": "Ship the agent-built fullstack app",\n    "done": false\n  }\n]\n'
  ],
  [
    'test/api.test.mjs',
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('fullstack API serves health and persists tasks', async () => {
  const server = await createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const health = await fetch(base + '/api/health').then(res => res.json());
    assert.equal(health.ok, true);

    const created = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Write an E2E test' })
    }).then(res => res.json());
    assert.equal(created.title, 'Write an E2E test');
    assert.equal(created.done, false);

    const updated = await fetch(base + '/api/tasks/' + created.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: true })
    }).then(res => res.json());
    assert.equal(updated.done, true);

    const html = await fetch(base + '/').then(res => res.text());
    assert.match(html, /Agent Ops/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
`
  ],
  [
    'README.md',
    '# Agent Built Fullstack\n\nA complete local fullstack task app generated by recursive agents.\n\n## Run\n\n```bash\nnpm start\n```\n\n## Test\n\n```bash\nnpm test\n```\n'
  ]
];

const [file, body] = pieces[Math.min(depth, pieces.length - 1)];
writeFileSync(path.join(appDir, file), body);

if (depth < pieces.length - 1) {
  const child = `AGENT-${depth + 1}`;
  const register = spawnSync(node, ['--import', 'tsx', cli, '--root', root, 'register', '--agent', child, '--force'], {
    cwd: repo,
    encoding: 'utf8'
  });
  if (register.status !== 0) throw new Error(register.stderr || register.stdout);

  const create = spawnSync(
    node,
    [
      '--import',
      'tsx',
      cli,
      '--root',
      root,
      'task',
      'create',
      '--agent',
      agent,
      '--for',
      child,
      '--parent',
      taskId,
      '--title',
      `build app layer ${depth + 1}`,
      '--detail',
      `Continue the local app from depth ${depth + 1}.`
    ],
    { cwd: repo, encoding: 'utf8' }
  );
  if (create.status !== 0) throw new Error(create.stderr || create.stdout);
}

console.log(`agent ${agent} wrote ${file}`);
