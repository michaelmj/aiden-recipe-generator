/**
 * Aiden Recipe Generator MCP Server — Streamable HTTP entry.
 *
 * The only entry point. Serves the MCP tools at http://127.0.0.1:<port>/mcp, so the server can be
 * started once (under `op run`, with the Fellow credentials) and Claude can connect to it without
 * needing any secrets of its own. Port comes from AIDEN_AI_MCP_PORT.
 */

import { APP_ID, getMcpHttpPort } from '@/config';
import { type RunningHttpServer, startHttpServer } from '@/httpServer';
import { createServices, type Services } from '@/server';

let running: RunningHttpServer | undefined;

/** One line on stderr saying whether tool calls will find a Fellow session. Never throws. */
async function describeFellowLogin(services: Services): Promise<string> {
  try {
    const status = await services.fellow.status();
    if (status.loggedIn) {
      const renew = status.autoReconnectSource ? `, auto-reconnect via ${status.autoReconnectSource}` : '';
      return `Fellow login OK (${status.email ?? 'unknown account'}${renew})`;
    }
    if (status.autoReconnect) {
      return 'Fellow: no session stored yet; will sign in from the environment credentials on the first tool call';
    }
    return 'Fellow: NOT logged in. Run `bun run auth:login`, or start with `bun run serve` so 1Password supplies the credentials';
  } catch (err) {
    return `Fellow: could not read the stored session (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function start() {
  const services = createServices();
  running = await startHttpServer({ port: getMcpHttpPort(), services });
  console.error(`${APP_ID} running (http) at ${running.url}`);
  // The path, never the token itself.
  console.error(`Bearer token written to ${running.tokenPath} (rotated on every start)`);
  console.error(await describeFellowLogin(services));
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
