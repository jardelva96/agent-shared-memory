/**
 * Facts about the project that every session should start with: "tests need Postgres on
 * 5477", "never commit to prod directly". A journal entry scrolls away and a handoff note
 * reaches one agent; a fact is handed to every agent at the start of its session (`prime`).
 */
import path from 'node:path';
import { ProjectFact } from '../models/types.js';
import { atomicWriteJson, readJson, withFileLock } from '../utils/fs.js';
import { createId } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import { resolvePaths } from './paths.js';

const MAX_FACT = 500;

export class FactStore {
  constructor(public readonly root = process.cwd()) {}

  private get file(): string {
    return path.join(resolvePaths(this.root).agentsDir, 'facts.json');
  }

  private get lock(): string {
    return path.join(resolvePaths(this.root).locksDir, 'facts.lock');
  }

  async list(): Promise<ProjectFact[]> {
    try {
      const data = await readJson<{ facts?: ProjectFact[] }>(this.file);
      return Array.isArray(data.facts) ? data.facts : [];
    } catch {
      return [];
    }
  }

  async remember(text: string, createdBy: string): Promise<ProjectFact> {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean) throw new Error('A fact needs some text.');
    if (clean.length > MAX_FACT) throw new Error(`Keep a fact under ${MAX_FACT} characters; it is read at the start of every session.`);
    return withFileLock(this.lock, async () => {
      const facts = await this.list();
      // The same fact twice is one fact.
      const existing = facts.find(f => f.text.toLowerCase() === clean.toLowerCase());
      if (existing) return existing;
      const fact: ProjectFact = { id: createId('F'), text: clean, createdBy, createdAt: nowIso() };
      await atomicWriteJson(this.file, { facts: [...facts, fact] });
      return fact;
    });
  }

  /** Removes a fact by id (or by a unique prefix of it). Returns whether one was removed. */
  async forget(id: string): Promise<boolean> {
    return withFileLock(this.lock, async () => {
      const facts = await this.list();
      const matches = facts.filter(f => f.id === id || f.id.startsWith(id));
      if (matches.length !== 1) return false;
      await atomicWriteJson(this.file, { facts: facts.filter(f => f !== matches[0]) });
      return true;
    });
  }
}
