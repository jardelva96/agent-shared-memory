import { configExists } from '../core/config.js';
import { AgentMemoryService } from '../core/service.js';
import { INVALID_PARAMS, MethodMap, RpcError, StdioServer } from './jsonrpc.js';
import { buildTools, callTool, ToolDefinition } from './tools.js';

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

export interface McpOptions {
  /** Fixes the identity for this connection, removing `agent` from every tool schema. */
  agentId?: string;
}

export function createMcpMethods(service: AgentMemoryService, options: McpOptions = {}): MethodMap {
  const methods: MethodMap = new Map();
  const pinned = options.agentId;
  const tools: ToolDefinition[] = buildTools(pinned);

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
      instructions: pinned
        ? `${INSTRUCTIONS}\n\nYou are ${pinned}. Your identity is fixed by this connection, so no tool takes an agent id.`
        : INSTRUCTIONS
    };
  });

  methods.set('notifications/initialized', async () => undefined);
  methods.set('notifications/cancelled', async () => undefined);
  methods.set('ping', async () => ({}));

  methods.set('tools/list', async () => ({ tools }));

  methods.set('tools/call', async params => {
    const { name, args } = readCallParams(params, tools);
    try {
      const text = await callTool(service, name, args, pinned);
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

export async function startMcpServer(service: AgentMemoryService, options: McpOptions = {}): Promise<void> {
  const pinned = options.agentId;

  if (pinned && (await configExists(service.root))) {
    // Claim the identity up front so the model never has to register itself, and so a
    // reconnect re-attaches to the same history instead of failing on a duplicate id.
    try {
      if (await service.store.stateExists(pinned)) {
        await service.heartbeat(pinned);
      } else {
        await service.register(pinned);
      }
    } catch (error) {
      process.stderr.write(`warning: could not claim ${pinned}: ${describe(error)}\n`);
    }
  }

  new StdioServer(createMcpMethods(service, options)).start();
  const who = pinned ? ` as ${pinned}` : '';
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio${who} (root: ${service.root})\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCallParams(
  params: unknown,
  tools: ToolDefinition[]
): { name: string; args: Record<string, unknown> } {
  const source = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof source.name !== 'string' || !source.name) {
    throw new RpcError(INVALID_PARAMS, 'tools/call requires a "name" string.');
  }
  if (!tools.some(tool => tool.name === source.name)) {
    throw new RpcError(INVALID_PARAMS, `Unknown tool: ${source.name}`);
  }
  const args =
    typeof source.arguments === 'object' && source.arguments !== null
      ? (source.arguments as Record<string, unknown>)
      : {};
  return { name: source.name, args };
}
