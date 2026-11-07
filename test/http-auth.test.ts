/**
 * Loopback HTTP lockdown (aiden-recipe-generator-m6i.2): bearer token, Host and Origin checks,
 * and the per-start token file.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';

import { MCP_HTTP_HOST } from '@/config';
import { httpTokenPath } from '@/httpAuth';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';

import { freshDataDir } from './helpers/offline';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auth-test', version: '0' } }
};

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * POST through node:http so the test controls Host and Origin exactly; fetch implementations
 * rewrite or forbid both.
 */
function rawPost(port: number, headers: Record<string, string>, path = '/mcp'): Promise<RawResponse> {
  const body = JSON.stringify(INIT);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: MCP_HTTP_HOST,
        port,
        path,
        method: 'POST',
        setHost: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body).toString(),
          ...headers
        }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('generated token file', () => {
  test('is written 0600, holds the token, and rotates on restart', async () => {
    freshDataDir();
    const first = await startHttpServer({ port: 0, warmUp: false });
    let firstToken: string;
    try {
      expect(first.tokenPath).toBe(httpTokenPath());
      const path = first.tokenPath as string;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      firstToken = readFileSync(path, 'utf8').trim();
      expect(firstToken.length).toBeGreaterThanOrEqual(40);

      const host = `${MCP_HTTP_HOST}:${first.port}`;
      expect((await rawPost(first.port, { host, authorization: `Bearer ${firstToken}` })).status).toBe(200);
    } finally {
      await first.close();
    }

    const second = await startHttpServer({ port: 0, warmUp: false });
    try {
      const path = second.tokenPath as string;
      const secondToken = readFileSync(path, 'utf8').trim();
      expect(secondToken).not.toBe(firstToken);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const host = `${MCP_HTTP_HOST}:${second.port}`;
      expect((await rawPost(second.port, { host, authorization: `Bearer ${firstToken}` })).status).toBe(401);
      expect((await rawPost(second.port, { host, authorization: `Bearer ${secondToken}` })).status).toBe(200);
    } finally {
      await second.close();
    }
  });

  test('a supplied token writes no file', async () => {
    freshDataDir();
    const running = await startHttpServer({ port: 0, warmUp: false, token: 'supplied' });
    try {
      expect(running.tokenPath).toBeUndefined();
      expect(() => statSync(httpTokenPath())).toThrow();
    } finally {
      await running.close();
    }
  });
});

describe('request checks', () => {
  const TOKEN = 'correct-horse-battery-staple';
  let running: RunningHttpServer;
  let host: string;
  let auth: Record<string, string>;

  beforeAll(async () => {
    freshDataDir();
    running = await startHttpServer({ port: 0, warmUp: false, token: TOKEN });
    host = `${MCP_HTTP_HOST}:${running.port}`;
    auth = { authorization: `Bearer ${TOKEN}` };
  });

  afterAll(async () => {
    await running?.close();
  });

  test('valid token and loopback Host is accepted, including localhost', async () => {
    expect((await rawPost(running.port, { host, ...auth })).status).toBe(200);
    expect((await rawPost(running.port, { host: `localhost:${running.port}`, ...auth })).status).toBe(200);
  });

  test('missing token -> 401 with a Bearer challenge', async () => {
    const res = await rawPost(running.port, { host });
    expect(res.status).toBe(401);
    expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer/);
  });

  test('wrong token, wrong scheme, or token prefix -> 401', async () => {
    for (const authorization of [
      'Bearer nope',
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Basic ${TOKEN}`,
      TOKEN,
      'Bearer '
    ]) {
      expect((await rawPost(running.port, { host, authorization })).status).toBe(401);
    }
  });

  test('401 applies to every path, not just /mcp', async () => {
    expect((await rawPost(running.port, { host }, '/other')).status).toBe(401);
  });

  test('foreign Host -> 403, even with a valid token', async () => {
    for (const bad of [
      'evil.example',
      `evil.example:${running.port}`,
      `${MCP_HTTP_HOST}:${running.port + 1}`,
      MCP_HTTP_HOST,
      `0.0.0.0:${running.port}`
    ]) {
      expect((await rawPost(running.port, { host: bad, ...auth })).status).toBe(403);
    }
  });

  test('missing Host is rejected', async () => {
    // The HTTP/1.1 parser answers 400 before the handler runs; either way it never reaches /mcp.
    expect([400, 403]).toContain((await rawPost(running.port, { ...auth })).status);
  });

  test('foreign Origin -> 403, even with a valid token', async () => {
    for (const origin of [
      'https://evil.example',
      `http://evil.example:${running.port}`,
      `https://${MCP_HTTP_HOST}:${running.port}`,
      'null'
    ]) {
      expect((await rawPost(running.port, { host, origin, ...auth })).status).toBe(403);
    }
  });

  test('loopback Origin is accepted', async () => {
    const origin = `http://${MCP_HTTP_HOST}:${running.port}`;
    expect((await rawPost(running.port, { host, origin, ...auth })).status).toBe(200);
  });

  test('Host/Origin are checked before the token', async () => {
    expect((await rawPost(running.port, { host: 'evil.example' })).status).toBe(403);
  });
});
