import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { SheetProfileStore } from '@/sheet/store';
import { toolResponse } from '@/tools/response';
import { UNTRUSTED_SHEET_TOOL_NOTE, UNTRUSTED_SHEET_TRUST_LABEL, untrustedSheetResponse } from '@/tools/untrusted';

const SheetProfileSchema = z.object({
  title: z.string(),
  origin: z.string().optional(),
  roast: z.string().optional(),
  processing: z.string().optional(),
  varietal: z.string().optional(),
  brewRatio: z.string().optional(),
  bloomRatio: z.string().optional(),
  bloomTime: z.string().optional(),
  bloomTemp: z.string().optional(),
  ssPulsesNumber: z.string().optional(),
  ssPulsesInterval: z.string().optional(),
  ssPulseTemps: z.string().optional(),
  batchPulsesNumber: z.string().optional(),
  batchPulsesInterval: z.string().optional(),
  batchPulseTemps: z.string().optional()
});

export function registerSheetTools(server: McpServer, sheetStore: SheetProfileStore) {
  server.registerTool(
    'sheet.sync',
    {
      title: 'Sync Community Sheet',
      description:
        'Refresh the local cache of community profiles from the configured community sheet. ' +
        'The source URL is set by the operator (AIDEN_AI_SHEET_CSV_URL) and cannot be chosen per call; ' +
        'the response reports which URL was fetched.',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), csvUrl: z.string(), profileCount: z.number() }
    },
    // No csvUrl argument: the fetch target must not be steerable by anything the model has read.
    async () => toolResponse(await sheetStore.sync({}))
  );

  server.registerTool(
    'sheet.list',
    {
      title: 'List All Community Recipes',
      description: `Get all community recipes from the cached sheet. Use this to browse available recipes. ${UNTRUSTED_SHEET_TOOL_NOTE}`,
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        count: z.number(),
        profiles: z.array(SheetProfileSchema),
        dataTrust: z.literal(UNTRUSTED_SHEET_TRUST_LABEL)
      }
    },
    async () => {
      const profiles = await sheetStore.getProfiles();
      return untrustedSheetResponse({ ok: true, count: profiles.length, profiles });
    }
  );

  server.registerTool(
    'sheet.search',
    {
      title: 'Search Community Recipes',
      description:
        'Filter community recipes by origin, roast, processing, or free text. Returns matching profiles with full brewing parameters. ' +
        UNTRUSTED_SHEET_TOOL_NOTE,
      inputSchema: {
        query: z.string().optional().describe('Free text search (roaster name, coffee name, varietal)'),
        origin: z.string().optional().describe('Coffee origin (e.g., Ethiopia, Colombia, Brazil)'),
        roast: z.string().optional().describe('Roast level (light, medium, dark)'),
        processing: z.string().optional().describe('Processing method (washed, natural, honey)'),
        limit: z.number().int().min(1).max(100).default(20)
      },
      outputSchema: {
        ok: z.boolean(),
        count: z.number(),
        profiles: z.array(SheetProfileSchema),
        dataTrust: z.literal(UNTRUSTED_SHEET_TRUST_LABEL)
      }
    },
    async ({ query, origin, roast, processing, limit }) => {
      const all = await sheetStore.getProfiles();

      const matches = all.filter((p) => {
        if (query) {
          const q = query.toLowerCase();
          const searchable = [p.title, p.origin, p.roast, p.processing, p.varietal]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!searchable.includes(q)) return false;
        }
        if (origin && !p.origin?.toLowerCase().includes(origin.toLowerCase())) return false;
        if (roast && !p.roast?.toLowerCase().includes(roast.toLowerCase())) return false;
        if (processing && !p.processing?.toLowerCase().includes(processing.toLowerCase())) return false;
        return true;
      });

      return untrustedSheetResponse({ ok: true, count: matches.length, profiles: matches.slice(0, limit) });
    }
  );
}
