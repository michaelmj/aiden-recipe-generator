import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SheetProfileStore } from '@/sheet/store';

const URL_OK = 'https://docs.google.com/spreadsheets/d/test/export?format=csv';
const SAMPLE = readFileSync('test/fixtures/sheet-sample.csv', 'utf8');

function freshStore(opts?: { timeoutMs?: number }) {
  process.env.AIDEN_AI_DATA_DIR = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  return new SheetProfileStore({ csvUrl: URL_OK, ...opts });
}

/** Swap in a stub fetch for the duration of `body`. */
async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('background sheet warm-up', () => {
  test('an unreachable sheet host does not reject the warm-up', async () => {
    const store = freshStore();
    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND docs.google.com');
    }) as unknown as typeof fetch;

    await withFetch(failing, async () => {
      await expect(store.warmCache()).resolves.toBeUndefined();
      expect(await store.getProfiles()).toEqual([]);
    });
  });

  test('a stalling host does not reject the warm-up either', async () => {
    const store = freshStore({ timeoutMs: 50 });
    const stalling = (async (_input: string | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Coffee,'));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
    }) as unknown as typeof fetch;

    await withFetch(stalling, async () => {
      await expect(store.warmCache()).resolves.toBeUndefined();
    });
  });

  test('a reader with no cache waits for the in-flight warm-up instead of seeing an empty sheet', async () => {
    const store = freshStore();
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(SAMPLE, { status: 200, headers: { 'content-type': 'text/csv' } });
    }) as unknown as typeof fetch;

    await withFetch(slow, async () => {
      const warm = store.warmCache(); // deliberately not awaited before the read
      expect(await store.getProfiles()).toHaveLength(3);
      await warm;
    });
  });

  test('concurrent warm-ups share one fetch', async () => {
    const store = freshStore();
    let calls = 0;
    const counting = (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(SAMPLE, { status: 200, headers: { 'content-type': 'text/csv' } });
    }) as unknown as typeof fetch;

    await withFetch(counting, async () => {
      await Promise.all([store.warmCache(), store.warmCache(), store.warmCache()]);
      expect(calls).toBe(1);
    });
  });
});
