// Spawned by tests/concurrency.test.ts to act as one independent agent process.
import { AgentMemoryService } from '../../src/core/service.js';
import { ActivityType } from '../../src/models/types.js';

const [root, agentId, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const types: ActivityType[] = ['INTENT', 'READING', 'CHANGED', 'TESTING', 'NOTE'];

const service = new AgentMemoryService(root);

try {
  await service.register(agentId, 'Backend', `TASK-${agentId}`);
  for (let i = 0; i < count; i++) {
    await service.activity({
      agentId,
      type: types[i % types.length],
      description: `${agentId} step ${i}`,
      pointer: { file: `src/Mod${i % 2}.cs`, symbol: `Mod${i % 2}.Run()` }
    });
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
