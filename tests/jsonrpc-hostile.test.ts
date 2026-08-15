import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INVALID_REQUEST, PARSE_ERROR, StdioServer } from '../src/mcp/jsonrpc.js';
import { AgentMemoryService } from '../src/core/service.js';
import { createMcpMethods } from '../src/mcp/server.js';

/** Drives handleLine through the public surface, capturing what would go to stdout. */
async function feed(lines: string[]): Promise<Array<Record<string, any>>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asm-rpc-'));
  try {
    const service = new AgentMemoryService(root);
    await service.init('RPC');
    const server = new StdioServer(createMcpMethods(service));

    const written: Array<Record<string, any>> = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string) => {
      const text = String(chunk).trim();
      if (text.startsWith('{')) written.push(JSON.parse(text));
      return true;
    };
    try {
      for (const line of lines) {
        await (server as any).handleLine(line);
      }
    } finally {
      (process.stdout as any).write = original;
    }
    return written;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a line that is valid JSON but not a request is refused, not obeyed', async () => {
  const replies = await feed(['null', '42', '"texto"']);
  assert.equal(replies.length, 3);
  for (const reply of replies) {
    assert.equal(reply.error.code, INVALID_REQUEST);
    assert.match(reply.error.message, /JSON object/);
  }
});

test('a batch is refused by name instead of looking like one failed request', async () => {
  const [reply] = await feed(['[{"jsonrpc":"2.0","id":1,"method":"ping"}]']);
  assert.equal(reply.error.code, INVALID_REQUEST);
  assert.match(reply.error.message, /Batch requests are not supported/);
});

test('a different protocol version is named rather than silently accepted', async () => {
  const [reply] = await feed(['{"jsonrpc":"1.0","id":2,"method":"ping"}']);
  assert.equal(reply.id, 2);
  assert.match(reply.error.message, /Unsupported jsonrpc version: 1\.0/);
});

test('broken JSON and a missing method get the right codes', async () => {
  const replies = await feed(['{"id":3,', '{"jsonrpc":"2.0","id":4}']);
  assert.equal(replies[0].error.code, PARSE_ERROR);
  assert.equal(replies[1].error.code, INVALID_REQUEST);
  assert.match(replies[1].error.message, /Missing method/);
});

test('an unknown notification is silent, and a request after it still answers', async () => {
  const replies = await feed([
    '{"jsonrpc":"2.0","method":"notifications/desconhecida"}',
    '{"jsonrpc":"2.0","id":9,"method":"ping"}'
  ]);
  assert.equal(replies.length, 1, 'a notification must never be answered');
  assert.equal(replies[0].id, 9);
});
