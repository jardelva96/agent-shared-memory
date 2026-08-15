import { access } from 'node:fs/promises';
import { ProjectConfig } from '../models/types.js';
import { atomicWriteJson, ensureDir, readJson } from '../utils/fs.js';
import { resolvePaths } from './paths.js';

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  staleAfterSeconds: 60,
  recentHistoryLimit: 20,
  projectName: 'Unnamed Project',
  autoCompactAfterEvents: 5000
};

export async function configExists(root = process.cwd()): Promise<boolean> {
  try {
    await access(resolvePaths(root).configFile);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(root = process.cwd()): Promise<ProjectConfig> {
  const paths = resolvePaths(root);
  try {
    return { ...DEFAULT_CONFIG, ...(await readJson<ProjectConfig>(paths.configFile)) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeConfig(config: ProjectConfig, root = process.cwd()): Promise<void> {
  const paths = resolvePaths(root);
  await ensureDir(paths.agentsDir);
  await atomicWriteJson(paths.configFile, config);
}
