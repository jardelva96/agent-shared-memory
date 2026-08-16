/**
 * Public API.
 *
 * The CLI and the MCP server are the two ways most people use this, but everything they
 * do goes through AgentMemoryService — so a host that already has its own process model
 * can drive the same store directly instead of shelling out.
 *
 * Deep imports (`agent-shared-memory/dist/core/...`) are not part of the contract: only
 * what is re-exported here is stable across versions.
 */

export { AgentMemoryService } from './core/service.js';
export type {
  ActivityInput,
  ActivityResult,
  CompactOptions,
  CompactResult,
  CreateScheduleInput,
  CreateTaskInput,
  FinishOptions,
  InboxResult,
  SendMessageInput
} from './core/service.js';

export { ScheduleStore, TaskStore, dependenciesOf } from './core/tasks.js';
export type { TaskFilter } from './core/tasks.js';

export { formatPointer, parsePointer, pointerKey, pointersOverlap } from './core/pointer.js';
export { detectConflicts, detectOverlapPairs } from './core/conflicts.js';
export type { OverlapPair } from './core/conflicts.js';

export { DEFAULT_CONFIG, configExists, readConfig, writeConfig } from './core/config.js';

export { executeTask, runQueue } from './core/runner.js';
export type { RunOutcome, RunnerOptions } from './core/runner.js';

export {
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createMcpMethods,
  startMcpServer
} from './mcp/server.js';
export type { McpOptions } from './mcp/server.js';

export { startDashboard } from './web/server.js';
export type { DashboardOptions } from './web/server.js';

export { DEFAULT_WATCHER_ID, assertGitRepo, currentChanges, runWatchPass } from './git/watcher.js';
export type { Attribution, ObservedChange, WatchPassResult, WatcherOptions } from './git/watcher.js';

export type {
  AgentActivity,
  AgentMessage,
  AgentState,
  AgentStatus,
  AgentTask,
  ActivityType,
  CodePointer,
  Conflict,
  ProjectConfig,
  TaskSchedule,
  TaskStatus
} from './models/types.js';
