// Spawned by tests/stdio.test.ts to exercise StdioServer over a real stdin/stdout pair.
import { INVALID_PARAMS, MethodMap, RpcError, StdioServer } from '../../src/mcp/jsonrpc.js';

const methods: MethodMap = new Map();
methods.set('echo', async params => ({ echo: params ?? null }));
methods.set('boom', async () => {
  throw new RpcError(INVALID_PARAMS, 'boom');
});

const server = new StdioServer(methods);

if (process.argv.includes('--poison-handler')) {
  // Fails inside handleLine itself, which is the one failure its own try/catch cannot see.
  const patched = server as unknown as { handleLine(line: string): Promise<void> };
  const original = patched.handleLine.bind(server);
  patched.handleLine = line =>
    line.includes('POISON') ? Promise.reject(new Error('poisoned line')) : original(line);
}

server.start();
