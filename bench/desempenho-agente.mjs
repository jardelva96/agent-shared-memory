#!/usr/bin/env node
// One agent process for the concurrency part of bench/desempenho.mjs: registers, writes M times
// on its own file and prints the latency of each write as JSON.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [root, id, count] = process.argv.slice(2);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { AgentMemoryService, parsePointer } = await import(pathToFileURL(dist).href);

const service = new AgentMemoryService(root);
await service.register(id);
const latencias = [];
for (let i = 0; i < Number(count); i++) {
  const t = performance.now();
  await service.activity({ agentId: id, type: 'NOTE', description: `passo ${i}`, pointer: parsePointer(`src/${id}.ts::f${i}`) });
  latencias.push(performance.now() - t);
}
process.stdout.write(JSON.stringify(latencias));
