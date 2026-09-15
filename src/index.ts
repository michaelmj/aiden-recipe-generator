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
import { RecipeDataset } from '@/recipes/dataset';
import { SheetProfileStore } from '@/sheet/store';
import { registerAuthTools } from '@/tools/auth';
import { registerDeviceTools } from '@/tools/device';
import { registerProfileTools } from '@/tools/profile';
import { registerRecipeTools } from '@/tools/recipe';
import { registerSheetTools } from '@/tools/sheet';
import { registerStorageTools } from '@/tools/storage';

const server = new McpServer({ name: APP_ID, version: APP_VERSION });
const fellow = new FellowClient();
const dataset = new RecipeDataset();
const sheetStore = new SheetProfileStore();

// Register all tools
registerAuthTools(server, fellow);
registerDeviceTools(server, fellow);
registerProfileTools(server, fellow);
registerRecipeTools(server, fellow);
registerSheetTools(server, dataset, sheetStore);
registerStorageTools(server);
registerPrompts(server);

/** Initialize the server: connect transport, then load the recipe sources in the background. */
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${APP_ID} running (stdio)`);

  // The bundled dataset is a local file, so this is a read, not a fetch; it still runs after the
  // transport is live so a slow disk cannot delay startup.
  void dataset.load().then(({ kept, dropped }) => {
    console.error(`Loaded ${kept} bundled recipes${dropped > 0 ? ` (${dropped} dropped)` : ''}`);
  });

  // The community sheet is opt-in, so with no AIDEN_AI_SHEET_CSV_URL this warm-up is a no-op and
  // the server never touches the network. When it is configured, the warm-up is still never
  // awaited: a remote third party must not delay or break startup. warmCache() swallows its own
  // failures; the recipe tools fall back to whatever is cached.
  if (!sheetStore.isConfigured()) return;

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
