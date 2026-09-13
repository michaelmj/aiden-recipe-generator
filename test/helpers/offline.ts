/**
 * Offline test harness.
 *
 * Every hardening test drives the server against hostile inputs, and none of them may reach the
 * real world: a suite that quietly falls back to docs.google.com or the Fellow API tests the
 * network, not the guards, and turns red on a plane. Importing this module (it is preloaded for
 * the whole suite via bunfig.toml) replaces `globalThis.fetch` with a stub that refuses every
 * call, so an un-stubbed request fails loudly instead of escaping.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whatever `new Response(...)` accepts as a body — `BodyInit` is not a global under tsc here. */
export type ResponseBody = ConstructorParameters<typeof Response>[0];

export class BlockedNetworkCallError extends Error {
  constructor(readonly url: string) {
    super(`Blocked network call to ${url}: tests must stub fetch (see test/helpers/offline.ts).`);
    this.name = 'BlockedNetworkCallError';
  }
}

const blockedCalls: string[] = [];

/** URLs the guard has refused so far, so a test can assert nothing tried to reach the network. */
export function blockedNetworkCalls(): readonly string[] {
  return blockedCalls;
}

export function clearBlockedNetworkCalls(): void {
  blockedCalls.length = 0;
}

/** Replace global fetch with a stub that refuses everything. Idempotent. */
export function installOfflineGuard(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    blockedCalls.push(url);
    throw new BlockedNetworkCallError(url);
  }) as unknown as typeof fetch;
}

/**
 * Swap in a stub fetch for the duration of `body`, then restore whatever was there before —
 * normally the offline guard, so a later test cannot accidentally inherit this stub.
 */
export async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = previous;
  }
}

/** A fetch stub that answers every request with the same response. */
export function respondWith(make: (input: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => make(String(input), init)) as unknown as typeof fetch;
}

/** A 200 response shaped like the sheet export endpoint's. */
export function csvResponse(body: ResponseBody, contentType = 'text/csv'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

/** Point the app's data dir at a fresh temp dir so no test reads or writes the real cache. */
export function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  process.env.AIDEN_AI_DATA_DIR = dir;
  return dir;
}

installOfflineGuard();
