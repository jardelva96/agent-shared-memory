import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentMemoryService } from '../src/core/service.js';
import { parsePointer } from '../src/core/pointer.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-demo-'));
const service = new AgentMemoryService(root);

await service.init('Demo Backend', { staleAfterSeconds: 60, recentHistoryLimit: 20 });
await service.register('AGENT-01', 'Backend', 'AUTH-184');
await service.register('AGENT-02', 'Backend', 'AUTH-185');
await service.register('AGENT-03', 'Backend', 'PAY-211');

await service.activity({
  agentId: 'AGENT-01',
  type: 'INTENT',
  description: 'Corrigindo validação de expiração do refresh token.',
  reason: 'Refresh token expirado ainda é aceito.',
  pointer: parsePointer('src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)')
});

const conflict = await service.activity({
  agentId: 'AGENT-02',
  type: 'INTENT',
  description: 'Adicionando auditoria ao fluxo de refresh token.',
  pointer: parsePointer('src/Auth/TokenService.cs::TokenService.ValidateRefreshToken(string refreshToken)')
});

await service.activity({
  agentId: 'AGENT-03',
  type: 'WAITING',
  description: 'Aguardando alteração de autenticação antes de integrar pagamento.',
  waitingFor: 'AGENT-01',
  pointer: parsePointer('src/Payments/PaymentService.cs::PaymentService.CreateAsync()')
});

console.log(`Demo project: ${root}`);
console.log(`Conflicts reported to AGENT-02: ${conflict.conflicts.length}`);
console.log('\n' + await service.store.readSharedMemory());

if (process.env.KEEP_DEMO !== '1') {
  await rm(root, { recursive: true, force: true });
}
