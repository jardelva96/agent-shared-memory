import { createInterface } from 'node:readline';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export type MethodHandler = (params: unknown) => Promise<unknown>;
export type MethodMap = Map<string, MethodHandler>;

/** Minimal JSON-RPC 2.0 server over newline-delimited stdin/stdout. */
export class StdioServer {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly methods: MethodMap) {}

  start(): void {
    const reader = createInterface({ input: process.stdin });
    reader.on('line', line => {
      // Chained so requests are processed in arrival order.
      this.queue = this.queue
        .then(() => this.handleLine(line))
        .catch(error => {
          const reason = error instanceof Error ? error.message : String(error);
          process.stderr.write(`jsonrpc: failed to handle a line: ${reason}\n`);
        });
    });
    reader.on('close', () => {
      process.exitCode = 0;
    });
  }

  private async handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }

    // A batch is a JSON-RPC array.
    if (Array.isArray(parsed)) {
      this.write({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: INVALID_REQUEST,
          message: 'Batch requests are not supported. Send one request per line.'
        }
      });
      return;
    }

    // Valid JSON is not necessarily a request.
    if (typeof parsed !== 'object' || parsed === null) {
      this.write({
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'Request must be a JSON object' }
      });
      return;
    }

    // Reject unknown protocol versions instead of guessing.
    const version = (parsed as JsonRpcMessage).jsonrpc;
    if (version !== undefined && version !== '2.0') {
      this.write({
        jsonrpc: '2.0',
        id: (parsed as JsonRpcMessage).id ?? null,
        error: { code: INVALID_REQUEST, message: `Unsupported jsonrpc version: ${String(version)}` }
      });
      return;
    }

    const message = parsed as JsonRpcMessage;
    const isNotification = message.id === undefined;
    const id = message.id ?? null;

    if (typeof message.method !== 'string') {
      if (!isNotification) {
        this.write({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Missing method' } });
      }
      return;
    }

    const handler = this.methods.get(message.method);
    if (!handler) {
      // Unknown notifications are ignored: JSON-RPC forbids replying to them.
      if (!isNotification) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${message.method}` }
        });
      }
      return;
    }

    try {
      const result = await handler(message.params);
      if (!isNotification) this.write({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      if (isNotification) return;
      const body = error instanceof RpcError
        ? { code: error.code, message: error.message, data: error.data }
        : { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
      this.write({ jsonrpc: '2.0', id, error: body });
    }
  }

  private write(payload: unknown): void {
    // JSON.stringify escapes newlines, so one message is always one line.
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}
