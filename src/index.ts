/**
 * Aiden Recipe Generator MCP Server — stdio entry.
 *
 * An MCP server that controls Fellow Aiden coffee machines. This entry speaks MCP over stdio for
 * clients that spawn the server themselves; src/http.ts serves the same tools over loopback HTTP.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { APP_ID } from '@/config';
import { createMcpServer, createServices, warmUp } from '@/server';

const services = createServices();
const server = createMcpServer(services);

/** Initialize the server: connect transport, then load the recipe sources in the background. */
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${APP_ID} running (stdio)`);
  warmUp(services);
}

// Graceful shutdown
let isShuttingDown = false;
async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`Received ${signal}, shutting down...`);
  try {
    await server.close();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
