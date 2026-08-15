import { detectOverlapPairs, OverlapPair } from '../core/conflicts.js';
import { formatPointer } from '../core/pointer.js';
import { effectiveStatus } from '../core/render.js';
import { AgentMemoryService } from '../core/service.js';
import { AgentStatus } from '../models/types.js';

export interface SnapshotAgent {
  id: string;
  role?: string;
  status: AgentStatus;
  task?: string;
  description: string;
  pointer: string;
  reason?: string;
  waitingFor?: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  /** Ids of other live agents pointing at the same file or symbol. */
  overlapsWith: string[];
  unread: number;
}

export interface SnapshotEvent {
  id: string;
  agentId: string;
  type: string;
  description: string;
  pointer: string;
  timestamp: string;
}

export interface DashboardSnapshot {
  project: string;
  generatedAt: string;
  staleAfterSeconds: number;
  agents: SnapshotAgent[];
  overlaps: OverlapPair[];
  events: SnapshotEvent[];
}

export async function buildSnapshot(service: AgentMemoryService, eventLimit = 40): Promise<DashboardSnapshot> {
  const config = await service.config();
  const [states, activities] = await Promise.all([
    service.states(),
    service.store.recentActivities(eventLimit)
  ]);

  const overlaps = detectOverlapPairs(states, config);
  const partners = new Map<string, Set<string>>();
  for (const pair of overlaps) {
    const [left, right] = pair.agents;
    if (!partners.has(left)) partners.set(left, new Set());
    if (!partners.has(right)) partners.set(right, new Set());
    partners.get(left)!.add(right);
    partners.get(right)!.add(left);
  }

  const sorted = states.sort((a, b) => a.id.localeCompare(b.id));
  const unread = await Promise.all(sorted.map(state => service.messages.unreadCount(state.id)));

  const agents = sorted
    .map<SnapshotAgent>((state, index) => ({
      id: state.id,
      role: state.role,
      status: effectiveStatus(state, config),
      task: state.task,
      description: state.current?.description ?? '-',
      pointer: formatPointer(state.current?.pointer),
      reason: state.current?.reason,
      waitingFor: state.current?.waitingFor,
      updatedAt: state.updatedAt,
      lastHeartbeatAt: state.lastHeartbeatAt,
      overlapsWith: [...(partners.get(state.id) ?? [])].sort(),
      unread: unread[index]
    }));

  return {
    project: config.projectName,
    generatedAt: new Date().toISOString(),
    staleAfterSeconds: config.staleAfterSeconds,
    agents,
    overlaps,
    events: activities.map(activity => ({
      id: activity.id,
      agentId: activity.agentId,
      type: activity.type,
      description: activity.description,
      pointer: formatPointer(activity.pointer),
      timestamp: activity.timestamp
    }))
  };
}
