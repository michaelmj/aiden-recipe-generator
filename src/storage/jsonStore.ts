import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type * as z from 'zod/v4';

const queues = new Map<string, Promise<void>>();

/** Serialize every read-modify-write cycle for one store within this process. */
export async function withStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  queues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(path) === queued) queues.delete(path);
  }
}

async function quarantine(path: string, reason: string): Promise<never> {
  const quarantined = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await rename(path, quarantined);
  throw new Error(`Invalid local store ${basename(path)} (${reason}); preserved as ${basename(quarantined)}.`);
}

/** Read bounded JSON and validate it at runtime. Missing files use the supplied empty value. */
export async function readStore<T>(path: string, schema: z.ZodType<T>, empty: () => T, maxBytes: number): Promise<T> {
  try {
    const info = await stat(path);
    if (info.size > maxBytes) return quarantine(path, `larger than ${maxBytes} bytes`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    return quarantine(path, error instanceof SyntaxError ? 'malformed JSON' : 'unreadable');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return quarantine(path, 'schema validation failed');
  return result.data;
}

/** Write a complete replacement beside the target, then atomically rename it into place. */
export async function atomicWriteStore(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
