/**
 * Streamable HTTP entry (aiden-recipe-generator-m6i.1): loopback-only listener, independent
 * sessions per client, and the same tool surface as the stdio entry.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { getMcpHttpPort, MCP_HTTP_HOST } from '@/config';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';

import { freshDataDir } from './helpers/offline';

/**
 * The offline guard replaces globalThis.fetch. Bun.fetch is the real one; this wrapper lets the
 * test reach the loopback server and still refuses anything else.
 */
const loopbackFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== MCP_HTTP_HOST) throw new Error(`test fetch is loopback-only, got ${url.href}`);
  return Bun.fetch(input, init);
}) as typeof fetch;

const TOKEN = 'test-token-for-http-transport';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let running: RunningHttpServer;

beforeAll(async () => {
  freshDataDir();
  running = await startHttpServer({ port: 0, warmUp: false, token: TOKEN });
});

afterAll(async () => {
  await running?.close();
});

async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    fetch: loopbackFetch,
    requestInit: { headers: AUTH }
  });
  const client = new Client({ name: 'http-transport-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('HTTP MCP entry', () => {
  test('binds loopback only', () => {
    expect(running.url.startsWith(`http://${MCP_HTTP_HOST}:`)).toBe(true);
    expect(MCP_HTTP_HOST).toBe('127.0.0.1');
  });

  test('answers initialize and tools/list', async () => {
    const { client } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('auth.status');
      expect(names).toContain('sheet.search');
    } finally {
      await client.close();
    }
  });

  test('concurrent clients get independent sessions', async () => {
    const a = await connect();
    const b = await connect();
    try {
      expect(a.transport.sessionId).toBeDefined();
      expect(b.transport.sessionId).toBeDefined();
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
      const [ta, tb] = await Promise.all([a.client.listTools(), b.client.listTools()]);
      expect(ta.tools.length).toBe(tb.tools.length);
      expect(running.sessionCount()).toBeGreaterThanOrEqual(2);

      await a.transport.terminateSession();
      await expect(a.client.listTools()).rejects.toThrow();
      expect((await b.client.listTools()).tools.length).toBe(tb.tools.length);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  test('rejects unknown sessions, non-initialize first requests, and other paths', async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      loopbackFetch(new URL(path, running.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...AUTH,
          ...headers
        },
        body: JSON.stringify(body)
      });
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    expect((await post('/mcp', list)).status).toBe(400);
    expect((await post('/mcp', list, { 'mcp-session-id': 'nope' })).status).toBe(404);
    expect((await post('/other', list)).status).toBe(404);
    const bad = await loopbackFetch(running.url, { method: 'POST', headers: AUTH, body: '{not json' });
    expect(bad.status).toBe(400);
  });

  test('a busy port fails with a clear message', async () => {
    await expect(startHttpServer({ port: running.port, warmUp: false })).rejects.toThrow(/already in use/);
  });
});

describe('AIDEN_AI_MCP_PORT', () => {
  test('defaults, accepts a valid port, rejects junk', () => {
    const saved = process.env.AIDEN_AI_MCP_PORT;
    try {
      delete process.env.AIDEN_AI_MCP_PORT;
      expect(getMcpHttpPort()).toBe(47_831);
      process.env.AIDEN_AI_MCP_PORT = '9001';
      expect(getMcpHttpPort()).toBe(9001);
      for (const junk of ['0', '70000', 'abc', '80.5', '-1']) {
        process.env.AIDEN_AI_MCP_PORT = junk;
        expect(() => getMcpHttpPort()).toThrow(/AIDEN_AI_MCP_PORT/);
      }
    } finally {
      if (saved === undefined) delete process.env.AIDEN_AI_MCP_PORT;
      else process.env.AIDEN_AI_MCP_PORT = saved;
    }
  });
});
