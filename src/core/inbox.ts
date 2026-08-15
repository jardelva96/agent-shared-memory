import { appendFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentMessage } from '../models/types.js';
import { atomicWrite, atomicWriteJson, ensureDir, readJson, withFileLock } from '../utils/fs.js';
import { assertAgentId } from '../utils/ids.js';
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
    await withFileLock(path.join(p.locksDir, `${assertAgentId(message.to)}.inbox.lock`), async () => {
      await appendFile(this.messageFile(message.to), `${JSON.stringify(message)}\n`, 'utf8');
    });
  }

  async list(agentId: string): Promise<AgentMessage[]> {
    // Resolved outside the try so an invalid id is reported instead of read as "empty".
    const file = this.messageFile(agentId);
    try {
      const text = await readFile(file, 'utf8');
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

  /** Agent ids that own an inbox file. */
  async listInboxes(): Promise<string[]> {
    try {
      const files = await readdir(this.paths.inboxDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.slice(0, -'.jsonl'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Drops already-read messages beyond the newest `keep`, so an inbox does not grow
   * forever. Unread messages are never discarded: the recipient has not seen them yet.
   * Returns how many were removed.
   */
  async trim(agentId: string, keep: number): Promise<number> {
    const p = this.paths;
    const file = this.messageFile(agentId);
    return withFileLock(path.join(p.locksDir, `${assertAgentId(agentId)}.inbox.lock`), async () => {
      const [messages, cursor] = await Promise.all([this.list(agentId), this.cursor(agentId)]);
      if (messages.length <= keep) return 0;

      const readCount = cursor.lastReadId
        ? messages.findIndex(message => message.id === cursor.lastReadId) + 1
        : 0;
      // Never drop past the read cursor, even if that leaves more than `keep`.
      const removable = Math.min(messages.length - keep, readCount);
      if (removable <= 0) return 0;

      const remaining = messages.slice(removable);
      await atomicWrite(file, remaining.map(m => JSON.stringify(m)).join('\n') + '\n');
      return removable;
    });
  }

  async markRead(agentId: string, messageId: string): Promise<void> {
    await ensureDir(this.paths.inboxDir);
    await atomicWriteJson(this.cursorFile(agentId), {
      lastReadId: messageId,
      lastReadAt: new Date().toISOString()
    } satisfies Cursor);
  }

  async cursor(agentId: string): Promise<Cursor> {
    const file = this.cursorFile(agentId);
    try {
      return await readJson<Cursor>(file);
    } catch {
      return {};
    }
  }

  private messageFile(agentId: string): string {
    return path.join(this.paths.inboxDir, `${assertAgentId(agentId)}.jsonl`);
  }

  private cursorFile(agentId: string): string {
    return path.join(this.paths.inboxDir, `${assertAgentId(agentId)}.cursor.json`);
  }
}
