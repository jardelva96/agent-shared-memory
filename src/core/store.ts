import { appendFile, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AgentActivity, AgentState, ProjectConfig } from '../models/types.js';
import { assertAgentId } from '../utils/ids.js';
import { atomicWrite, atomicWriteJson, ensureDir, isLockTimeout, readJson, withFileLock } from '../utils/fs.js';
import { resolvePaths } from './paths.js';
import { renderActivity, renderAgentHeader, renderSessionBanner, renderSharedMemory } from './render.js';

export class MemoryStore {
  constructor(public readonly root = process.cwd()) {}

  get paths() {
    return resolvePaths(this.root);
  }

  async initialize(config: ProjectConfig): Promise<void> {
    const p = this.paths;
    await Promise.all([
      ensureDir(p.agentsDir),
      ensureDir(p.stateDir),
      ensureDir(p.historyDir),
      ensureDir(p.eventsDir),
      ensureDir(p.locksDir)
    ]);
    await atomicWriteJson(p.configFile, config);
    try {
      await readFile(p.eventsFile, 'utf8');
    } catch {
      await atomicWrite(p.eventsFile, '');
    }
    await this.refreshSharedMemory(config);
  }

  async stateExists(agentId: string): Promise<boolean> {
    // Resolved outside the try so an invalid id is reported instead of read as "absent".
    const file = this.stateFile(agentId);
    try {
      await readFile(file, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async readState(agentId: string): Promise<AgentState> {
    return readJson<AgentState>(this.stateFile(agentId));
  }

  async writeState(state: AgentState): Promise<void> {
    await atomicWriteJson(this.stateFile(state.id), state);
  }

  async listStates(): Promise<AgentState[]> {
    const p = this.paths;
    await ensureDir(p.stateDir);
    const files = (await readdir(p.stateDir)).filter(f => f.endsWith('.json'));
    const states: AgentState[] = [];
    for (const file of files) {
      try {
        states.push(await readJson<AgentState>(path.join(p.stateDir, file)));
      } catch {
        // Ignore a transient/corrupt state file rather than breaking all agents.
      }
    }
    return states;
  }

  async deleteState(agentId: string): Promise<void> {
    await rm(this.stateFile(agentId), { force: true });
  }

  /**
   * Opens the journal for a new session. Writes the header for a brand-new agent, and
   * otherwise appends a session banner: an existing history is never overwritten, so an
   * id reused after `unregister` keeps its audit trail.
   */
  async openHistory(state: AgentState): Promise<void> {
    const p = this.paths;
    await ensureDir(p.historyDir);
    const file = this.historyFile(state.id);

    try {
      await readFile(file, 'utf8');
    } catch {
      await atomicWrite(file, `${renderAgentHeader(state)}\n`);
      return;
    }

    await withFileLock(path.join(p.locksDir, `${assertAgentId(state.id)}.history.lock`), async () => {
      await appendFile(file, `${renderSessionBanner(state)}\n`, 'utf8');
    });
  }

  /** Agent ids that own a history file, including agents no longer in state/. */
  async listHistoryAgents(): Promise<string[]> {
    try {
      const files = await readdir(this.paths.historyDir);
      return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    } catch {
      return [];
    }
  }

  /**
   * Moves an agent history out of the way and starts a fresh file that points at the archive.
   * Returns the archive path, or undefined when there was nothing to rotate.
   */
  async archiveHistory(agentId: string, stamp: string): Promise<string | undefined> {
    const p = this.paths;
    const source = this.historyFile(agentId);
    return withFileLock(path.join(p.locksDir, `${assertAgentId(agentId)}.history.lock`), async () => {
      let existing: string;
      try {
        existing = await readFile(source, 'utf8');
      } catch {
        return undefined;
      }
      await ensureDir(p.historyArchiveDir);
      const target = path.join(p.historyArchiveDir, `${assertAgentId(agentId)}-${stamp}.md`);
      await rename(source, target);
      const header = existing.split('\n---\n')[0].trimEnd();
      await atomicWrite(source, `${header}\n\n> Earlier entries archived in archive/${path.basename(target)}.\n`);
      return target;
    });
  }

  /**
   * Keeps the newest `keep` events in the journal and moves the older ones into an archive file.
   * Returns how many events were archived and where, or undefined when nothing was trimmed.
   */
  async archiveEvents(keep: number, stamp: string): Promise<{ archived: number; file: string } | undefined> {
    const p = this.paths;
    return withFileLock(path.join(p.locksDir, 'events.lock'), async () => {
      let text: string;
      try {
        text = await readFile(p.eventsFile, 'utf8');
      } catch {
        return undefined;
      }
      const lines = text.split('\n').filter(Boolean);
      if (lines.length <= keep) return undefined;

      const cut = lines.length - keep;
      await ensureDir(p.eventsArchiveDir);
      const file = path.join(p.eventsArchiveDir, `events-${stamp}.jsonl`);
      await atomicWrite(file, `${lines.slice(0, cut).join('\n')}\n`);
      await atomicWrite(p.eventsFile, `${lines.slice(cut).join('\n')}\n`);
      return { archived: cut, file };
    });
  }

  async countEvents(): Promise<number> {
    try {
      const text = await readFile(this.paths.eventsFile, 'utf8');
      return text.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /**
   * Appends to the global journal and, unless `history` is false, to the agent own history.
   * Observations about an agent that did not report them go to the journal only, so a
   * personal history stays a record of what that agent actually declared.
   */
  async appendActivity(activity: AgentActivity, options: { history?: boolean } = {}): Promise<void> {
    const p = this.paths;
    await ensureDir(p.historyDir);
    await ensureDir(p.eventsDir);

    if (options.history !== false) {
      await withFileLock(path.join(p.locksDir, `${assertAgentId(activity.agentId)}.history.lock`), async () => {
        await appendFile(this.historyFile(activity.agentId), `${renderActivity(activity)}\n`, 'utf8');
      });
    }

    await withFileLock(path.join(p.locksDir, 'events.lock'), async () => {
      await appendFile(p.eventsFile, `${JSON.stringify(activity)}\n`, 'utf8');
    });
  }

  async recentActivities(limit = 20): Promise<AgentActivity[]> {
    try {
      const text = await readFile(this.paths.eventsFile, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const items: AgentActivity[] = [];
      for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
        try {
          items.push(JSON.parse(lines[i]) as AgentActivity);
        } catch {
          // Ignore malformed line, preserving the rest of the event log.
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  /**
   * Regenerates the central panel. Callers write state and the journal first, so this is
   * derived data: if the lock is too contended to get, the write that just happened is
   * still durable and the next agent to refresh picks it up from disk. Failing here would
   * throw away work that already succeeded, which is the wrong trade under concurrency.
   */
  async refreshSharedMemory(config: ProjectConfig): Promise<void> {
    const p = this.paths;
    try {
      await withFileLock(path.join(p.locksDir, 'shared-memory.lock'), async () => {
        const [states, recent] = await Promise.all([
          this.listStates(),
          this.recentActivities(config.recentHistoryLimit)
        ]);
        await atomicWrite(p.sharedMemoryFile, renderSharedMemory(states, recent, config));
      });
    } catch (error) {
      if (!isLockTimeout(error)) throw error;
    }
  }

  async readSharedMemory(): Promise<string> {
    return readFile(this.paths.sharedMemoryFile, 'utf8');
  }

  private stateFile(agentId: string): string {
    return path.join(this.paths.stateDir, `${assertAgentId(agentId)}.json`);
  }

  private historyFile(agentId: string): string {
    return path.join(this.paths.historyDir, `${assertAgentId(agentId)}.md`);
  }
}
