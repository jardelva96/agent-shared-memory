import { appendFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentActivity, AgentState, ProjectConfig } from '../models/types.js';
import { assertAgentId } from '../utils/ids.js';
import { atomicWrite, atomicWriteJson, ensureDir, isLockTimeout, readJson, readJsonIfExists, tryFileLock, withFileLock } from '../utils/fs.js';
import { readConfig } from './config.js';
import { resolvePaths } from './paths.js';
import { FactStore } from './facts.js';
import { renderActivity, renderAgentHeader, renderSessionBanner, renderSharedMemory } from './render.js';
import { ReservationStore } from './reservations.js';

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
    // In parallel; a state removed meanwhile (unregister) or torn is skipped, not waited for.
    const states = await Promise.all(
      files.map(file => readJsonIfExists<AgentState>(path.join(p.stateDir, file)).catch(() => undefined))
    );
    return states.filter((state): state is AgentState => state !== undefined);
  }

  async deleteState(agentId: string): Promise<void> {
    await rm(this.stateFile(agentId), { force: true });
  }

  /** Opens the journal for a new session. */
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

  /** Moves an agent history out of the way and starts a fresh file that points at the archive. */
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
    return (await this.journalLines()).length;
  }

  private async journalLines(): Promise<string[]> {
    try {
      const text = await readFile(this.paths.eventsFile, 'utf8');
      return text.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Appends to the global journal and, unless `history` is false, to the agent own history. */
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
    return tail(await this.journalLines(), limit);
  }

  /** Regenerates the central panel. */
  async refreshSharedMemory(config: ProjectConfig, options: { wait?: boolean } = {}): Promise<number | undefined> {
    const lock = path.join(this.paths.locksDir, 'shared-memory.lock');
    // A writer that finds the panel busy leaves this mark and moves on; whoever holds the panel
    // checks it after finishing and renders again. Without it every write queued for the panel.
    const marked = await touch(this.panelMark);
    const run = async () => {
      await rm(this.panelMark, { force: true }).catch(() => undefined);
      return this.renderPanel(config);
    };

    let size: number | undefined;
    for (let round = 0; round < PANEL_ROUNDS; round++) {
      if (round === 0 && (options.wait || !marked)) {
        try {
          size = await withFileLock(lock, run);
        } catch (error) {
          if (!isLockTimeout(error)) throw error;
          return undefined;
        }
      } else {
        const result = await tryFileLock(lock, run);
        if (!result.acquired) return size;
        size = result.value;
      }
      if (!(await present(this.panelMark))) return size;
    }
    // Still marked after a few rounds of a busy burst: the next write or read renders it.
    return size;
  }

  /** Writes SHARED_MEMORY.md and returns the journal size, so the caller can decide to compact. */
  private async renderPanel(config: ProjectConfig): Promise<number> {
    const p = this.paths;
    const [states, lines, reservations, facts] = await Promise.all([
      this.listStates(),
      this.journalLines(),
      new ReservationStore(p.root).active(),
      new FactStore(p.root).list()
    ]);
    await atomicWrite(
      p.sharedMemoryFile,
      renderSharedMemory(states, tail(lines, config.recentHistoryLimit), config, { reservations, facts })
    );
    return lines.length;
  }

  private get panelMark(): string {
    return path.join(this.paths.locksDir, 'shared-memory.dirty');
  }

  async readSharedMemory(): Promise<string> {
    // A write left the panel behind during a burst: bring it up to date before anyone reads it.
    if (await present(this.panelMark)) await this.refreshSharedMemory(await readConfig(this.root), { wait: true });
    return readFile(this.paths.sharedMemoryFile, 'utf8');
  }

  private stateFile(agentId: string): string {
    return path.join(this.paths.stateDir, `${assertAgentId(agentId)}.json`);
  }

  private historyFile(agentId: string): string {
    return path.join(this.paths.historyDir, `${assertAgentId(agentId)}.md`);
  }
}

/** Renders after a write at most this many times in a row before leaving the rest to the next one. */
const PANEL_ROUNDS = 3;

async function touch(file: string): Promise<boolean> {
  try {
    await ensureDir(path.dirname(file));
    await writeFile(file, '');
    return true;
  } catch {
    return false;
  }
}

async function present(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/** Newest first, skipping any line torn by a partial write. */
function tail(lines: string[], limit: number): AgentActivity[] {
  const items: AgentActivity[] = [];
  for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
    try {
      items.push(JSON.parse(lines[i]) as AgentActivity);
    } catch {
      // Ignore malformed line, preserving the rest of the event log.
    }
  }
  return items;
}
