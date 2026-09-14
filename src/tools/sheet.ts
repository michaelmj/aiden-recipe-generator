/**
 * The recipe-lookup tools.
 *
 * `sheet.list` and `sheet.search` read the bundled dataset first (aiden-recipe-generator-8z3.4).
 * The live community sheet is appended only when an operator has opted in with
 * AIDEN_AI_SHEET_CSV_URL; with nothing configured these tools make no network call at all.
 * Every record says which source it came from, so a reader can tell a reviewed bundled recipe from
 * a line a stranger typed into a public sheet five minutes ago.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { Recipe, RecipeDataset, SearchQuery } from '@/recipes/dataset';
import type { SheetProfile, SheetProfileStore } from '@/sheet/store';
import { toolResponse } from '@/tools/response';
import {
  BUNDLED_DATASET_TRUST_LABEL,
  recipeResponse,
  TRUST_LABELS,
  UNTRUSTED_SHEET_TOOL_NOTE,
  UNTRUSTED_SHEET_TRUST_LABEL
} from '@/tools/untrusted';

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

/**
 * One returned recipe. The brewing fields are the same either way; `trust` and the bundled-only
 * `id`/`source`/`notes` are what distinguish where it came from.
 */
const RecipeRecordSchema = SheetProfileSchema.extend({
  trust: z.enum(TRUST_LABELS),
  id: z.string().optional(),
  source: z
    .object({
      kind: z.enum(['first-party', 'community-sheet', 'roaster']),
      credit: z.string().optional(),
      url: z.string().optional()
    })
    .optional(),
  notes: z.string().optional()
});

type RecipeRecord = z.infer<typeof RecipeRecordSchema>;

/** Response shape shared by list and search: `count` is the match total, `profiles` the page of it. */
const listOutputSchema = {
  ok: z.boolean(),
  count: z.number(),
  profiles: z.array(RecipeRecordSchema),
  dataTrust: z.enum(TRUST_LABELS)
};

function bundledRecord(recipe: Recipe): RecipeRecord {
  const { id, source, notes, ...profile } = recipe;
  return { ...profile, id, source, ...(notes ? { notes } : {}), trust: BUNDLED_DATASET_TRUST_LABEL };
}

function sheetRecord(profile: SheetProfile): RecipeRecord {
  return { ...profile, trust: UNTRUSTED_SHEET_TRUST_LABEL };
}

const contains = (value: string | undefined, needle: string) =>
  (value ?? '').toLowerCase().includes(needle.toLowerCase());

/** The sheet-side filter, matched to what RecipeDataset.search does over the bundled records. */
function sheetMatches(p: SheetProfile, q: SearchQuery): boolean {
  if (q.query && !contains([p.title, p.origin, p.roast, p.processing, p.varietal].filter(Boolean).join(' '), q.query)) {
    return false;
  }
  if (q.origin && !contains(p.origin, q.origin)) return false;
  if (q.roast && !contains(p.roast, q.roast)) return false;
  if (q.processing && !contains(p.processing, q.processing)) return false;
  return true;
}

export function registerSheetTools(server: McpServer, dataset: RecipeDataset, sheetStore: SheetProfileStore) {
  /**
   * Bundled records first, then any live-sheet ones. Order matters past `limit`: a truncated
   * answer should drop stranger-written entries before reviewed ones.
   */
  async function collect(q: SearchQuery = {}): Promise<RecipeRecord[]> {
    const bundled = (await dataset.search(q)).map(bundledRecord);
    const live = (await sheetStore.getProfiles()).filter((p) => sheetMatches(p, q)).map(sheetRecord);
    return [...bundled, ...live];
  }

  server.registerTool(
    'sheet.sync',
    {
      title: 'Sync Community Sheet',
      description:
        'Refresh the local cache of community profiles from the configured community sheet. ' +
        'The live sheet is opt-in: without AIDEN_AI_SHEET_CSV_URL there is nothing to sync and the ' +
        'bundled dataset is the only recipe source. The source URL is set by the operator and cannot ' +
        'be chosen per call; the response reports which URL was fetched.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        configured: z.boolean(),
        csvUrl: z.string().optional(),
        profileCount: z.number().optional(),
        message: z.string().optional()
      }
    },
    // No csvUrl argument: the fetch target must not be steerable by anything the model has read.
    async () => {
      if (!sheetStore.isConfigured()) {
        return toolResponse({
          ok: false,
          configured: false,
          message:
            'No community sheet is configured, so nothing was fetched. The bundled recipe dataset is ' +
            'the default source; an operator can set AIDEN_AI_SHEET_CSV_URL to opt into a live sheet.'
        });
      }
      return toolResponse({ configured: true, ...(await sheetStore.sync({})) });
    }
  );

  server.registerTool(
    'sheet.list',
    {
      title: 'List All Recipes',
      description:
        'Get every known recipe: the bundled dataset that ships with this server, plus the cached ' +
        `community sheet when an operator has opted into one. ${UNTRUSTED_SHEET_TOOL_NOTE}`,
      inputSchema: {},
      outputSchema: listOutputSchema
    },
    async () => {
      const profiles = await collect();
      return recipeResponse(
        { ok: true, count: profiles.length, profiles },
        { hasUntrusted: profiles.some((p) => p.trust === UNTRUSTED_SHEET_TRUST_LABEL) }
      );
    }
  );

  server.registerTool(
    'sheet.search',
    {
      title: 'Search Recipes',
      description:
        'Filter recipes by origin, roast, processing, or free text across the bundled dataset and ' +
        'any opted-in community sheet. Returns matching profiles with full brewing parameters. ' +
        UNTRUSTED_SHEET_TOOL_NOTE,
      inputSchema: {
        query: z.string().optional().describe('Free text search (roaster name, coffee name, varietal)'),
        origin: z.string().optional().describe('Coffee origin (e.g., Ethiopia, Colombia, Brazil)'),
        roast: z.string().optional().describe('Roast level (light, medium, dark)'),
        processing: z.string().optional().describe('Processing method (washed, natural, honey)'),
        limit: z.number().int().min(1).max(100).default(20)
      },
      outputSchema: listOutputSchema
    },
    async ({ query, origin, roast, processing, limit }) => {
      const matches = await collect({ query, origin, roast, processing });
      const page = matches.slice(0, limit);
      return recipeResponse(
        { ok: true, count: matches.length, profiles: page },
        { hasUntrusted: page.some((p) => p.trust === UNTRUSTED_SHEET_TRUST_LABEL) }
      );
    }
  );
}
