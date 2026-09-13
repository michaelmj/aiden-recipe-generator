/**
 * Aiden Recipe Generator MCP Server
 *
 * An MCP server that controls Fellow Aiden coffee machines.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { APP_ID, APP_VERSION } from '@/config';
import { FellowClient } from '@/fellow/client';
import { registerPrompts } from '@/prompts';
import { SheetProfileStore } from '@/sheet/store';
import { registerAuthTools } from '@/tools/auth';
import { registerDeviceTools } from '@/tools/device';
import { registerProfileTools } from '@/tools/profile';
import { registerSheetTools } from '@/tools/sheet';
import { registerStorageTools } from '@/tools/storage';

const server = new McpServer({ name: APP_ID, version: APP_VERSION });
const fellow = new FellowClient();
const sheetStore = new SheetProfileStore();

// Register all tools
registerAuthTools(server, fellow);
registerDeviceTools(server, fellow);
registerProfileTools(server, fellow);
registerSheetTools(server, sheetStore);
registerStorageTools(server);
registerPrompts(server);

/** Initialize the server: connect transport, then warm the sheet cache in the background. */
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${APP_ID} running (stdio)`);

  // Warm-up runs after the transport is live and is never awaited here: the community sheet is a
  // remote third party, and an unreachable or stalling host must not delay or break startup.
  // warmCache() swallows its own failures; sheet tools fall back to whatever is cached.
  void sheetStore
    .warmCache()
    .then(() => sheetStore.getProfiles())
    .then((profiles) => {
      console.error(`Loaded ${profiles.length} community profiles`);
    })
    .catch((err) => {
      console.error('Community sheet warm-up failed:', err instanceof Error ? err.message : err);
    });
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
