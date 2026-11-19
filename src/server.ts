/**
 * Server assembly shared by every transport.
 *
 * The stdio entry (src/index.ts) and the HTTP entry (src/http.ts) both build their MCP servers
 * here, so the two cannot drift in which tools or prompts they expose. Long-lived state — the
 * Fellow session, the bundled dataset and the community-sheet cache — lives in one `Services`
 * object per process. The HTTP entry creates one McpServer per session, and all of them share
 * that object, so a second session neither logs in again nor reloads the recipes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

/** Process-wide state that every MCP session shares. */
export interface Services {
  fellow: FellowClient;
  dataset: RecipeDataset;
  sheetStore: SheetProfileStore;
}

export function createServices(): Services {
  return {
    fellow: new FellowClient(),
    dataset: new RecipeDataset(),
    sheetStore: new SheetProfileStore()
  };
}

/** A fresh McpServer with every tool and prompt registered against the shared services. */
export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: APP_ID, version: APP_VERSION });
  registerAuthTools(server, services.fellow);
  registerDeviceTools(server, services.fellow);
  registerProfileTools(server, services.fellow);
  registerRecipeTools(server, services.fellow);
  registerSheetTools(server, services.dataset, services.sheetStore);
  registerStorageTools(server, services.fellow);
  registerPrompts(server);
  return server;
}

/**
 * Load the recipe sources in the background. Call once per process, after the transport is live.
 * Never awaited by callers: neither source may delay or break startup.
 */
export function warmUp(services: Services): void {
  const { dataset, sheetStore } = services;

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
