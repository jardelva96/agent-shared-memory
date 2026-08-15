import { AgentMemoryService } from '../core/service.js';
import { INVALID_PARAMS, MethodMap, RpcError, StdioServer } from './jsonrpc.js';
import { callTool, TOOLS } from './tools.js';

export const SERVER_NAME = 'agent-shared-memory';
/** Keep in sync with package.json: dist/ has no package.json to read it from. */
export const SERVER_VERSION = '1.1.0';

/** Newest first. The client's version is echoed back when we support it. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Shared operational memory for several coding agents working in the same repository.',
  '',
  'Follow the cycle READ -> INTENT -> CODE -> RESULT -> READ:',
  '1. Call memory_status before any relevant code action.',
  '2. Call memory_record with type INTENT before changing code, saying what and why.',
  '3. Make only the announced change.',
  '4. Call memory_record with CHANGED, CREATED, TESTING, FOUND, WAITING or DONE right after.',
  '',
  'Use semantic pointers "file::symbol::parameter", never line numbers.',
  'Overlaps are reported as warnings, not locks: never undo another agent work; adjust to coexist or record WAITING.',
  'When memory_status reports unread messages, call memory_inbox before continuing.'
].join('\n');

export function createMcpMethods(service: AgentMemoryService): MethodMap {
  const methods: MethodMap = new Map();

  methods.set('initialize', async params => {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS
    };
  });

  methods.set('notifications/initialized', async () => undefined);
  methods.set('notifications/cancelled', async () => undefined);
  methods.set('ping', async () => ({}));

  methods.set('tools/list', async () => ({ tools: TOOLS }));

  methods.set('tools/call', async params => {
    const { name, args } = readCallParams(params);
    try {
      const text = await callTool(service, name, args);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      // Execution failures come back as tool results so the agent can read and recover.
      return {
        content: [{ type: 'text', text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  });

  return methods;
}

export function startMcpServer(service: AgentMemoryService): void {
  new StdioServer(createMcpMethods(service)).start();
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio (root: ${service.root})\n`);
}

function readCallParams(params: unknown): { name: string; args: Record<string, unknown> } {
  const source = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof source.name !== 'string' || !source.name) {
    throw new RpcError(INVALID_PARAMS, 'tools/call requires a "name" string.');
  }
  if (!TOOLS.some(tool => tool.name === source.name)) {
    throw new RpcError(INVALID_PARAMS, `Unknown tool: ${source.name}`);
  }
  const args =
    typeof source.arguments === 'object' && source.arguments !== null
      ? (source.arguments as Record<string, unknown>)
      : {};
  return { name: source.name, args };
}
