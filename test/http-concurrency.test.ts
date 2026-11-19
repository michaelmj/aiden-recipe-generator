/**
 * Shared state under concurrent MCP sessions (aiden-recipe-generator-m6i.5).
 *
 * One HTTP process serves every Claude session, so parallel tool calls from different sessions
 * meet in the same FellowClient, the same storage files and the same sheet cache. These drive
 * two real SDK sessions at once and check that the shared pieces hold: one token refresh, no
 * lost brew-log writes, one sheet fetch. Fellow and the sheet are stubbed on globalThis.fetch;
 * the MCP transport uses Bun.fetch on loopback and never sees the stub.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MCP_HTTP_HOST } from '@/config';
import { FellowClient } from '@/fellow/client';
import { type Keychain, setKeychainForTests } from '@/fellow/keychain';
import { SessionStore } from '@/fellow/session';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';
import { RecipeDataset } from '@/recipes/dataset';
import { SheetProfileStore } from '@/sheet/store';

import { freshDataDir, installOfflineGuard } from './helpers/offline';
import { SHEET_URL } from './helpers/sheet';

const TOKEN = 'test-token-for-http-concurrency';
const SAMPLE = readFileSync('test/fixtures/sheet-sample.csv', 'utf8');

const loopbackFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== MCP_HTTP_HOST) throw new Error(`test fetch is loopback-only, got ${url.href}`);
  return Bun.fetch(input, init);
}) as typeof fetch;

function memoryKeychain(): Keychain {
  const items = new Map<string, string>();
  const key = (service: string, account: string) => `${service} ${account}`;
  return {
    async get(service, account) {
      return items.get(key(service, account)) ?? null;
    },
    async set(service, account, secret) {
      items.set(key(service, account), secret);
    },
    async delete(service, account) {
      return items.delete(key(service, account));
    }
  };
}

function jwt(name: string, expiresInMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }))
    .toString('base64')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.${name}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Upstream calls seen by the stub, so tests can count refreshes and sheet fetches. */
const upstream: string[] = [];
const count = (fragment: string) => upstream.filter((u) => u.includes(fragment)).length;

function installUpstreamStub(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    upstream.push(url);
    // Slow enough that parallel callers really do overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (url.includes('/auth/refresh')) {
      return json({ accessToken: jwt('fresh', 3_600_000), refreshToken: `refresh-${upstream.length}` });
    }
    if (url.includes('/devices')) return json([]);
    if (url.startsWith('https://docs.google.com/')) {
      return new Response(SAMPLE, { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    throw new Error(`unexpected upstream request to ${url}`);
  }) as unknown as typeof fetch;
}

let running: RunningHttpServer;

beforeAll(async () => {
  freshDataDir();
  setKeychainForTests(memoryKeychain());
  running = await startHttpServer({
    port: 0,
    warmUp: false,
    token: TOKEN,
    services: {
      fellow: new FellowClient(),
      dataset: new RecipeDataset(),
      sheetStore: new SheetProfileStore({ csvUrl: SHEET_URL })
    }
  });
});

afterAll(async () => {
  await running?.close();
  setKeychainForTests(undefined);
});

beforeEach(() => {
  upstream.length = 0;
  installUpstreamStub();
});

afterEach(() => installOfflineGuard());

async function session(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    fetch: loopbackFetch,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  const client = new Client({ name: 'http-concurrency-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function withSessions(body: (a: Client, b: Client) => Promise<void>): Promise<void> {
  const [a, b] = await Promise.all([session(), session()]);
  try {
    await body(a, b);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
}

function structured<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as T;
}

describe('concurrent MCP sessions over HTTP', () => {
  test('a stale Fellow token is refreshed once, however many sessions call at once', async () => {
    await new SessionStore().write({
      email: 'someone@example.com',
      accessToken: jwt('stale', -60_000),
      refreshToken: 'refresh-token-1',
      obtainedAtMs: Date.now() - 3_600_000,
      accessTokenExpMs: Date.now() - 60_000
    });

    await withSessions(async (a, b) => {
      const calls = [a, b, a, b].map((c) => c.callTool({ name: 'aiden.listDevices', arguments: {} }));
      for (const result of await Promise.all(calls)) expect(result.isError).toBeFalsy();
    });

    // More than one would spend the same rotating refresh token twice and store a dead one.
    expect(count('/auth/refresh')).toBe(1);
  });

  test('parallel brew logs from two sessions are all kept', async () => {
    const brew = (i: number) => ({
      name: 'storage.logBrew',
      arguments: {
        coffeeName: `Coffee ${i}`,
        profileTitle: `Profile ${i}`,
        recipe: {
          ratio: 16,
          bloomEnabled: true,
          bloomRatio: 2,
          bloomDuration: 30,
          bloomTemperature: 94,
          ssPulsesEnabled: true,
          ssPulsesNumber: 3,
          ssPulsesInterval: 23,
          ssPulseTemperatures: [94, 93, 92],
          batchPulsesEnabled: false,
          batchPulsesNumber: 1
        }
      }
    });

    await withSessions(async (a, b) => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).callTool(brew(i))));
      const ids = results.map((r) => structured<{ brewId: string }>(r).brewId);
      expect(new Set(ids).size).toBe(20);

      const history = structured<{ entries: { id: string }[] }>(
        await a.callTool({ name: 'storage.getHistory', arguments: { limit: 100 } })
      );
      expect(new Set(history.entries.map((e) => e.id))).toEqual(new Set(ids));
    });
  });

  test('parallel sheet.sync from two sessions shares one fetch and leaves a readable cache', async () => {
    await withSessions(async (a, b) => {
      const results = await Promise.all([a, b, a, b].map((c) => c.callTool({ name: 'sheet.sync', arguments: {} })));
      for (const r of results) expect(structured<{ ok: boolean }>(r).ok).toBe(true);
      expect(count('docs.google.com')).toBe(1);

      const listed = structured<{ count?: number; profiles?: unknown[] }>(
        await b.callTool({ name: 'sheet.list', arguments: {} })
      );
      expect(JSON.stringify(listed)).toContain('untrusted-community-sheet');
    });
  });
});
