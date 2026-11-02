import path from 'node:path';

export interface MemoryPaths {
  root: string;
  agentsDir: string;
  stateDir: string;
  historyDir: string;
  historyArchiveDir: string;
  eventsDir: string;
  eventsArchiveDir: string;
  inboxDir: string;
  tasksDir: string;
  tasksArchiveDir: string;
  schedulesDir: string;
  locksDir: string;
  sharedMemoryFile: string;
  configFile: string;
  eventsFile: string;
}

export function resolvePaths(root = process.cwd()): MemoryPaths {
  const agentsDir = path.join(root, '.agents');
  return {
    root,
    agentsDir,
    stateDir: path.join(agentsDir, 'state'),
    historyDir: path.join(agentsDir, 'history'),
    historyArchiveDir: path.join(agentsDir, 'history', 'archive'),
    eventsDir: path.join(agentsDir, 'events'),
    eventsArchiveDir: path.join(agentsDir, 'events', 'archive'),
    inboxDir: path.join(agentsDir, 'inbox'),
    tasksDir: path.join(agentsDir, 'tasks'),
    tasksArchiveDir: path.join(agentsDir, 'tasks', 'archive'),
    schedulesDir: path.join(agentsDir, 'schedules'),
    locksDir: path.join(agentsDir, '.locks'),
    sharedMemoryFile: path.join(agentsDir, 'SHARED_MEMORY.md'),
    configFile: path.join(agentsDir, 'config.json'),
    eventsFile: path.join(agentsDir, 'events', 'events.jsonl')
  };
}
