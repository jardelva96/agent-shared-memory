import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentMessage } from '../models/types.js';
import { atomicWriteJson, ensureDir, readJson, withFileLock } from '../utils/fs.js';
import { safeName } from '../utils/ids.js';
import { resolvePaths } from './paths.js';

interface Cursor {
  lastReadId?: string;
  lastReadAt?: string;
}

/**
 * Per-agent message queues. Each recipient owns an append-only JSONL file plus a small
 * cursor recording the last message it acknowledged, so unread state survives restarts
 * without ever rewriting the message log.
 */
export class InboxStore {
  constructor(public readonly root = process.cwd()) {}

  private get paths() {
    return resolvePaths(this.root);
  }

  async append(message: AgentMessage): Promise<void> {
    const p = this.paths;
    await ensureDir(p.inboxDir);
    await withFileLock(path.join(p.locksDir, `${safeName(message.to)}.inbox.lock`), async () => {
      await appendFile(this.messageFile(message.to), `${JSON.stringify(message)}\n`, 'utf8');
    });
  }

  async list(agentId: string): Promise<AgentMessage[]> {
    try {
      const text = await readFile(this.messageFile(agentId), 'utf8');
      const messages: AgentMessage[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as AgentMessage);
        } catch {
          // Skip a torn line rather than losing the whole inbox.
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  async unread(agentId: string): Promise<AgentMessage[]> {
    const [messages, cursor] = await Promise.all([this.list(agentId), this.cursor(agentId)]);
    if (!cursor.lastReadId) return messages;
    const index = messages.findIndex(message => message.id === cursor.lastReadId);
    // An unknown cursor means the log moved under us: treat everything as unread.
    return index < 0 ? messages : messages.slice(index + 1);
  }

  async unreadCount(agentId: string): Promise<number> {
    return (await this.unread(agentId)).length;
  }

  async markRead(agentId: string, messageId: string): Promise<void> {
    await ensureDir(this.paths.inboxDir);
    await atomicWriteJson(this.cursorFile(agentId), {
      lastReadId: messageId,
      lastReadAt: new Date().toISOString()
    } satisfies Cursor);
  }

  async cursor(agentId: string): Promise<Cursor> {
    try {
      return await readJson<Cursor>(this.cursorFile(agentId));
    } catch {
      return {};
    }
  }

  private messageFile(agentId: string): string {
    return path.join(this.paths.inboxDir, `${safeName(agentId)}.jsonl`);
  }

  private cursorFile(agentId: string): string {
    return path.join(this.paths.inboxDir, `${safeName(agentId)}.cursor.json`);
  }
}
