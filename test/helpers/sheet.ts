/**
 * Store-level helpers for the sheet tests.
 *
 * Every sheet test does the same three things: point the data dir at a temp dir, stub fetch with
 * one CSV body, and sync a fresh store. These live here so there is one copy of that scaffolding
 * and the tests themselves are only the case they cover. Network stubbing itself belongs to
 * ./offline.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SheetProfile } from '@/sheet/store';
import { SheetProfileStore } from '@/sheet/store';
import { registerSheetTools } from '@/tools/sheet';
import { csvResponse, freshDataDir, respondWith, withFetch } from './offline';

/** Stand-in for the community sheet's export endpoint; an allowed host, so the URL check passes. */
export const SHEET_URL = 'https://docs.google.com/spreadsheets/d/test/export?format=csv';

/** A fresh store against a fresh data dir, so no test reads another's cache. */
export function freshStore(opts?: { csvUrl?: string; cacheTtlMs?: number; timeoutMs?: number }): SheetProfileStore {
  freshDataDir();
  return new SheetProfileStore({ csvUrl: SHEET_URL, ...opts });
}

/**
 * Sync one CSV body through a fresh store and return the profiles it was willing to keep.
 * Rejects when the sync does, so a test can assert either the kept rows or the refusal.
 */
export async function profilesFromCsv(csv: string, contentType = 'text/csv'): Promise<SheetProfile[]> {
  const store = freshStore();
  return withFetch(
    respondWith(() => csvResponse(csv, contentType)),
    async () => {
      await store.sync({});
      return store.getProfiles();
    }
  );
}

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
};
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type CapturedTool = { description: string; handler: ToolHandler };

/**
 * Register the sheet tools against a stub server that just captures each handler, over a store
 * synced from `csv`. Lets a test invoke a tool callback the way an agent would, with no transport.
 */
export async function sheetTools(csv: string): Promise<Map<string, CapturedTool>> {
  const store = freshStore();

  return withFetch(
    respondWith(() => csvResponse(csv)),
    async () => {
      await store.sync({});

      const tools = new Map<string, CapturedTool>();
      const stub = {
        registerTool(name: string, config: { description: string }, handler: ToolHandler) {
          tools.set(name, { description: config.description, handler });
        }
      };
      registerSheetTools(stub as unknown as McpServer, store);
      return tools;
    }
  );
}

/** Run one sheet tool over `csv` and return its text and structured halves. */
export async function callSheetTool(
  csv: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const tool = (await sheetTools(csv)).get(name);
  if (!tool) throw new Error(`${name} was not registered`);

  const res = await tool.handler(args);
  return { text: res.content[0]?.text ?? '', structured: res.structuredContent };
}
