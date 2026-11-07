/**
 * MCP over Streamable HTTP, bound to loopback.
 *
 * Stateful sessions: each `initialize` creates its own transport and McpServer, keyed by the
 * `mcp-session-id` the transport issues, and every later request must carry that id. All sessions
 * share one `Services` object (one Fellow session, one dataset, one sheet cache), and warm-up runs
 * once per process rather than once per session.
 *
 * The listener only ever binds MCP_HTTP_HOST (127.0.0.1). Authentication and Host/Origin checks
 * are layered on in aiden-recipe-generator-m6i.2; until then any local process can reach /mcp.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { MCP_HTTP_HOST, MCP_HTTP_MAX_BODY_BYTES } from '@/config';
import { createMcpServer, createServices, type Services, warmUp } from '@/server';

export const MCP_PATH = '/mcp';

export interface HttpServerOptions {
  /** Port to listen on; 0 picks a free one (tests). */
  port: number;
  /** Shared services; created fresh when omitted. */
  services?: Services;
  /** Run the recipe-source warm-up after listening. Default true. */
  warmUp?: boolean;
}

export interface RunningHttpServer {
  /** The port actually bound (differs from the requested one when that was 0). */
  port: number;
  /** Base URL of the MCP endpoint. */
  url: string;
  /** Number of live MCP sessions. */
  sessionCount(): number;
  /** Close every session, then stop listening. */
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Read and parse a JSON body, refusing anything past MCP_HTTP_MAX_BODY_BYTES. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MCP_HTTP_MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MCP_HTTP_MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Parse error: body is not valid JSON');
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const services = options.services ?? createServices();
  const sessions = new Map<string, Session>();

  async function openSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    // An initialize that failed never got a session id, so nothing else will ever close it.
    if (!transport.sessionId) await server.close();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== MCP_PATH) throw new HttpError(404, 'Not found');

    const sessionId = headerValue(req, 'mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) throw new HttpError(404, 'Session not found');

    switch (req.method) {
      case 'POST': {
        const body = await readJsonBody(req);
        if (session) return session.transport.handleRequest(req, res, body);
        if (isInitializeRequest(body)) return openSession(req, res, body);
        throw new HttpError(400, 'Bad request: no session id, and the body is not an initialize request');
      }
      case 'GET':
      case 'DELETE':
        if (!session) throw new HttpError(400, 'Bad request: missing mcp-session-id');
        return session.transport.handleRequest(req, res);
      default:
        res.setHeader('allow', 'GET, POST, DELETE');
        throw new HttpError(405, 'Method not allowed');
    }
  }

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        sendJsonRpcError(res, err.status, err.message);
        return;
      }
      console.error('MCP HTTP request failed:', err instanceof Error ? err.message : err);
      sendJsonRpcError(res, 500, 'Internal server error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${options.port} on ${MCP_HTTP_HOST} is already in use. Is another aiden server running? ` +
              'Stop it, or set AIDEN_AI_MCP_PORT to a free port.'
          )
        );
        return;
      }
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(options.port, MCP_HTTP_HOST, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;
  if (options.warmUp !== false) warmUp(services);

  let closing: Promise<void> | undefined;
  return {
    port,
    url: `http://${MCP_HTTP_HOST}:${port}${MCP_PATH}`,
    sessionCount: () => sessions.size,
    close() {
      closing ??= (async () => {
        const open = [...sessions.values()];
        sessions.clear();
        await Promise.allSettled(open.map(({ server }) => server.close()));
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          // Standalone SSE streams (GET /mcp) hold their sockets open; drop them so close() returns.
          httpServer.closeAllConnections?.();
        });
      })();
      return closing;
    }
  };
}
