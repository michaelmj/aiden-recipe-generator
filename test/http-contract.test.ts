/**
 * HTTP MCP contract (aiden-recipe-generator-m6i.6): the path Claude Code actually takes.
 *
 * The server generates its own token and writes it to the data dir, scripts/mcp-headers.sh (the
 * .mcp.json headersHelper) turns that file into an Authorization header, and the SDK client
 * drives initialize, tools/list and a read-only tool call with it. Clients without the token,
 * or carrying a foreign Origin, are refused before any MCP handling. No network, no Fellow
 * credentials: the data dir is a fresh temp dir and the offline guard blocks everything else.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MCP_HTTP_HOST } from '@/config';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';

import { freshDataDir } from './helpers/offline';

const HEADERS_HELPER = join(import.meta.dir, '..', 'scripts', 'mcp-headers.sh');

/** Real fetch, loopback only; the offline guard still owns globalThis.fetch. */
const loopbackFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== MCP_HTTP_HOST) throw new Error(`test fetch is loopback-only, got ${url.href}`);
  return Bun.fetch(input, init);
}) as typeof fetch;

function runHeadersHelper(dataDir: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([HEADERS_HELPER], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dataDir, AIDEN_AI_DATA_DIR: dataDir }
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function client(headers: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    fetch: loopbackFetch,
    requestInit: { headers }
  });
  return { client: new Client({ name: 'http-contract-test', version: '0.0.0' }), transport };
}

let dataDir: string;
let running: RunningHttpServer;

beforeAll(async () => {
  dataDir = freshDataDir();
  // No `token`: the server generates one and writes it to the data dir, as `bun run serve` does.
  running = await startHttpServer({ port: 0, warmUp: false });
});

afterAll(async () => {
  await running?.close();
});

describe('HTTP MCP contract', () => {
  test('headersHelper emits the Authorization header for the token the server wrote', () => {
    expect(running.tokenPath).toBe(join(dataDir, 'http-token'));
    const { code, stdout } = runHeadersHelper(dataDir);
    expect(code).toBe(0);
    const headers = JSON.parse(stdout) as Record<string, string>;
    expect(Object.keys(headers)).toEqual(['Authorization']);
    expect(headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/);
  });

  test('initialize, tools/list and a read-only tool call with the helper headers', async () => {
    const headers = JSON.parse(runHeadersHelper(dataDir).stdout) as Record<string, string>;
    const { client: c, transport } = client(headers);
    await c.connect(transport);
    try {
      expect(c.getServerVersion()?.name).toBe('aiden-ai-profile-generator');
      expect(transport.sessionId).toBeDefined();

      const names = (await c.listTools()).tools.map((t) => t.name);
      for (const tool of ['auth.status', 'aiden.listDevices', 'sheet.search', 'storage.logBrew']) {
        expect(names).toContain(tool);
      }

      // Fresh data dir, no environment credentials: reads the (absent) session, no network.
      const result = await c.callTool({ name: 'auth.status', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ok: true, loggedIn: false });
    } finally {
      await c.close();
    }
  });

  test('no token -> the SDK client cannot connect (401)', async () => {
    const before = running.sessionCount();
    const { client: c, transport } = client({});
    await expect(c.connect(transport)).rejects.toThrow(/401|Unauthorized/i);
    expect(running.sessionCount()).toBe(before);
  });

  test('wrong token -> 401', async () => {
    const { client: c, transport } = client({ Authorization: 'Bearer not-the-token' });
    await expect(c.connect(transport)).rejects.toThrow(/401|Unauthorized/i);
  });

  test('foreign Origin -> 403, even with the right token', async () => {
    const headers = JSON.parse(runHeadersHelper(dataDir).stdout) as Record<string, string>;
    const before = running.sessionCount();
    const { client: c, transport } = client({ ...headers, Origin: 'http://evil.example' });
    await expect(c.connect(transport)).rejects.toThrow(/403|Forbidden/i);
    expect(running.sessionCount()).toBe(before);
  });

  test('headersHelper fails, printing the fix, when the server has not been started', () => {
    const empty = freshDataDir();
    try {
      const { code, stdout, stderr } = runHeadersHelper(empty);
      expect(code).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('bun run serve');
    } finally {
      rmSync(empty, { recursive: true, force: true });
      process.env.AIDEN_AI_DATA_DIR = dataDir;
    }
  });
});
