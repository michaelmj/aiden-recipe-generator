/**
 * Brew Log - tracks brew attempts and feedback for learning.
 * Stored in ~/.aiden-ai-profile-generator/brew-log.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAppDataDir } from '@/config';

/** A single brew attempt with optional feedback */
export type BrewEntry = {
  id: string;
  timestamp: number;
  coffee: {
    name: string;
    roaster?: string;
    origin?: string;
    roast?: string;
    processing?: string;
  };
  profile: {
    id?: string;
    title: string;
    ratio: number;
    bloomTemp: number;
    bloomDuration: number;
  };
  feedback?: {
    rating: 1 | 2 | 3 | 4 | 5;
    taste?: string;
    notes?: string;
  };
};

type BrewLog = { entries: BrewEntry[] };

const LOG_FILE = 'brew-log.json';

async function getLogPath(): Promise<string> {
  const dir = getAppDataDir();
  await mkdir(dir, { recursive: true });
  return join(dir, LOG_FILE);
}

async function readLog(): Promise<BrewLog> {
  try {
    const data = await readFile(await getLogPath(), 'utf-8');
    return JSON.parse(data) as BrewLog;
  } catch {
    return { entries: [] };
  }
}

async function writeLog(log: BrewLog): Promise<void> {
  await writeFile(await getLogPath(), JSON.stringify(log, null, 2));
}

/** Log a new brew attempt */
export async function logBrew(entry: Omit<BrewEntry, 'id' | 'timestamp'>): Promise<BrewEntry> {
  const log = await readLog();
  const newEntry: BrewEntry = {
    ...entry,
    id: `brew-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now()
  };
  log.entries.push(newEntry);
  await writeLog(log);
  return newEntry;
}

/** Add taste feedback to an existing brew entry */
export async function addFeedback(brewId: string, feedback: BrewEntry['feedback']): Promise<BrewEntry | null> {
  const log = await readLog();
  const entry = log.entries.find((e) => e.id === brewId);
  if (!entry) return null;
  entry.feedback = feedback;
  await writeLog(log);
  return entry;
}

/** Get recent brews, newest first */
export async function getRecentBrews(limit = 20): Promise<BrewEntry[]> {
  const log = await readLog();
  return log.entries.slice(-limit).reverse();
}

/** Search brews by coffee name, roaster, or origin */
export async function searchBrews(query: string): Promise<BrewEntry[]> {
  const log = await readLog();
  const q = query.toLowerCase();
  return log.entries.filter((e) => {
    const searchable = [
      e.coffee.name,
      e.coffee.roaster,
      e.coffee.origin,
      e.coffee.roast,
      e.coffee.processing,
      e.profile.title
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return searchable.includes(q);
  });
}

/** Find past brews with similar coffee characteristics */
export async function getSimilarBrews(coffee: {
  origin?: string;
  roast?: string;
  processing?: string;
}): Promise<BrewEntry[]> {
  const log = await readLog();
  return log.entries.filter((e) => {
    if (coffee.origin && e.coffee.origin?.toLowerCase().includes(coffee.origin.toLowerCase())) return true;
    if (coffee.roast && e.coffee.roast?.toLowerCase().includes(coffee.roast.toLowerCase())) return true;
    if (coffee.processing && e.coffee.processing?.toLowerCase().includes(coffee.processing.toLowerCase())) return true;
    return false;
  });
}
