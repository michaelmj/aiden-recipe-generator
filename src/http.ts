/**
 * Aiden Recipe Generator MCP Server — Streamable HTTP entry.
 *
 * Serves the same tools as the stdio entry at http://127.0.0.1:<port>/mcp, so the server can be
 * started once (under `op run`, with the Fellow credentials) and Claude can connect to it without
 * needing any secrets of its own. Port comes from AIDEN_AI_MCP_PORT.
 */

import { APP_ID, getMcpHttpPort } from '@/config';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';

let running: RunningHttpServer | undefined;

async function start() {
  running = await startHttpServer({ port: getMcpHttpPort() });
  console.error(`${APP_ID} running (http) at ${running.url}`);
  // The path, never the token itself.
  console.error(`Bearer token written to ${running.tokenPath} (rotated on every start)`);
}

let isShuttingDown = false;
async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`Received ${signal}, shutting down...`);
  try {
    await running?.close();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
