import { AgentMemoryService } from '../core/service.js';
import { AgentActivity, AgentState } from '../models/types.js';
import { changedFiles, describeChange, GitChange, isGitRepo } from './repo.js';

export const DEFAULT_WATCHER_ID = 'GIT-WATCHER';

/** The coordination directory is not project work; it would otherwise flood every pass. */
const IGNORED_PREFIXES = ['.agents/'];

export type Attribution = 'declared' | 'undeclared' | 'ambiguous';

export interface ObservedChange {
  change: GitChange;
  attribution: Attribution;
  /** Set only when exactly one agent plausibly owns the change. */
  agentId?: string;
  candidates: string[];
}

export interface WatchPassResult {
  observed: ObservedChange[];
  undeclared: number;
  ambiguous: number;
}

export interface WatcherOptions {
  watcherId?: string;
  /** Seed the baseline so a first pass reports nothing that predates the watcher. */
  baseline?: Map<string, string>;
  record?: boolean;
}

export function changeSignature(change: GitChange): string {
  return `${change.code}:${change.insertions ?? '?'}:${change.deletions ?? '?'}:${change.from ?? ''}`;
}

export async function assertGitRepo(root: string): Promise<void> {
  if (!(await isGitRepo(root))) {
    throw new Error(`Not a git repository: ${root}. The watcher needs one to read the working tree.`);
  }
}

/** Current working-tree changes, excluding the coordination directory. */
export async function currentChanges(root: string): Promise<GitChange[]> {
  const changes = await changedFiles(root);
  return changes.filter(change => !IGNORED_PREFIXES.some(prefix => change.path.startsWith(prefix)));
}

export async function baselineOf(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const change of await currentChanges(root)) map.set(change.path, changeSignature(change));
  return map;
}

/** Runs one comparison against the working tree and records what it finds. */
export async function runWatchPass(
  service: AgentMemoryService,
  seen: Map<string, string>,
  options: WatcherOptions = {}
): Promise<WatchPassResult> {
  const watcherId = options.watcherId ?? DEFAULT_WATCHER_ID;
  const record = options.record !== false;

  const [changes, states, recent] = await Promise.all([
    currentChanges(service.root),
    service.states(),
    service.store.recentActivities(100)
  ]);

  const observed: ObservedChange[] = [];

  for (const change of changes) {
    const signature = changeSignature(change);
    if (seen.get(change.path) === signature) continue;
    seen.set(change.path, signature);

    const candidates = attribute(change, states, recent);
    const attribution: Attribution =
      candidates.length === 1 ? 'declared' : candidates.length === 0 ? 'undeclared' : 'ambiguous';
    const entry: ObservedChange = {
      change,
      attribution,
      candidates,
      ...(candidates.length === 1 ? { agentId: candidates[0] } : {})
    };
    observed.push(entry);

    if (record) await recordObservation(service, entry, watcherId);
  }

  // A path that went back to its committed state should be reported again if it changes later.
  const live = new Set(changes.map(change => change.path));
  for (const path of [...seen.keys()]) if (!live.has(path)) seen.delete(path);

  return {
    observed,
    undeclared: observed.filter(o => o.attribution === 'undeclared').length,
    ambiguous: observed.filter(o => o.attribution === 'ambiguous').length
  };
}

async function recordObservation(
  service: AgentMemoryService,
  entry: ObservedChange,
  watcherId: string
): Promise<AgentActivity> {
  const pointer = { file: entry.change.path };
  const summary = describeChange(entry.change);

  if (entry.attribution === 'declared') {
    return service.observe({
      agentId: entry.agentId!,
      description: `git: ${summary}`,
      pointer
    });
  }

  const description =
    entry.attribution === 'ambiguous'
      ? `git: ${summary}, claimed by more than one agent (${entry.candidates.join(', ')})`
      : `git: ${summary}, not declared by any agent`;

  // No single owner, so this stays out of every personal history.
  return service.observe({ agentId: watcherId, description, pointer, history: false });
}

function attribute(change: GitChange, states: AgentState[], recent: AgentActivity[]): string[] {
  const paths = new Set([change.path, ...(change.from ? [change.from] : [])]);

  const byPointer = states
    .filter(state => state.current?.pointer && paths.has(normalize(state.current.pointer.file)))
    .map(state => state.id);
  if (byPointer.length > 0) return unique(byPointer);

  // Nobody points at the file right now; fall back to whoever recently worked on it.
  const known = new Set(states.map(state => state.id));
  const byHistory = recent
    .filter(event => known.has(event.agentId) && event.pointer && paths.has(normalize(event.pointer.file)))
    .map(event => event.agentId);
  return unique(byHistory);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalize(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}
