import { AgentState, CodePointer, Conflict, ProjectConfig } from '../models/types.js';
import { pointersOverlap } from './pointer.js';
import { effectiveStatus } from './render.js';

const ACTIVE_STATUSES = new Set(['WORKING', 'READING', 'TESTING', 'WAITING', 'ONLINE']);

export interface OverlapPair {
  agents: [string, string];
  exact: boolean;
  pointers: [CodePointer, CodePointer];
}

export function detectConflicts(states: AgentState[], requesterId: string, pointer?: CodePointer): Conflict[] {
  if (!pointer) return [];
  const conflicts: Conflict[] = [];
  for (const state of states) {
    if (state.id === requesterId || !ACTIVE_STATUSES.has(state.status) || !state.current?.pointer) continue;
    const relation = pointersOverlap(pointer, state.current.pointer);
    if (!relation.overlap) continue;
    conflicts.push({
      agentId: state.id,
      status: state.status,
      task: state.task,
      pointer: state.current.pointer,
      description: state.current.description,
      exact: relation.exact
    });
  }
  return conflicts;
}

/**
 * Every pair of live agents currently pointing at the same file or symbol.
 *
 * Unlike detectConflicts, which answers "who clashes with this one write", this is the
 * whole-panel view. Staleness is honoured: an agent that stopped sending heartbeats is
 * not reported as an active clash.
 */
export function detectOverlapPairs(states: AgentState[], config: ProjectConfig): OverlapPair[] {
  const active = states
    .filter(state => state.current?.pointer && ACTIVE_STATUSES.has(effectiveStatus(state, config)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const left = active[i];
      const right = active[j];
      const relation = pointersOverlap(left.current!.pointer, right.current!.pointer);
      if (!relation.overlap) continue;
      pairs.push({
        agents: [left.id, right.id],
        exact: relation.exact,
        pointers: [left.current!.pointer!, right.current!.pointer!]
      });
    }
  }
  return pairs;
}
