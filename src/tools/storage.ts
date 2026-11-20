/**
 * Storage Tools - MCP tools for brew history and user settings.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { RecipeSchema, ResourceIdSchema, recipeOf } from '@/schemas';
import {
  addFeedback,
  type BrewEntry,
  completeRecipe,
  getBrew,
  getRecentBrews,
  getSimilarBrews,
  logBrew,
  searchBrews
} from '@/storage/brewLog';
import { restoreProfile, snapshotProfile } from '@/storage/profileArchive';
import { getSettings, type UserSettings, updateSettings } from '@/storage/userSettings';
import { annotationsFor } from '@/tools/annotations';
import { toolResponse } from '@/tools/response';

/**
 * A logged brew as tools show it: the profile by title and its whole recipe — bloom and every
 * single-serve and batch pulse step. Entries logged before full recipes were recorded say
 * `partial: true` and hold only ratio and bloom.
 */
const BrewEntrySchema: z.ZodType<BrewEntry> = z.object({
  id: z.string(),
  timestamp: z.number(),
  coffee: z.object({
    name: z.string(),
    roaster: z.string().optional(),
    origin: z.string().optional(),
    roast: z.string().optional(),
    processing: z.string().optional()
  }),
  profile: z.union([
    z.object({ title: z.string(), recipe: RecipeSchema }),
    z.object({
      title: z.string(),
      partial: z.literal(true),
      recipe: z.object({ ratio: z.number(), bloomTemperature: z.number(), bloomDuration: z.number() })
    })
  ]),
  feedback: z
    .object({
      rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      taste: z.string().optional(),
      notes: z.string().optional()
    })
    .optional()
});

const UserSettingsSchema: z.ZodType<UserSettings> = z.object({
  grinder: z.string().optional(),
  defaultDeviceId: z.string().optional(),
  preferredRatio: z.number().optional(),
  elevation: z.number().optional(),
  notes: z.string().optional()
});

const RecipeInputSchema = RecipeSchema.optional().describe(
  'The whole recipe as brewed (bloom and single-serve and batch pulse steps), when not reading it from the device'
);

export function registerStorageTools(server: McpServer, fellow: FellowClient) {
  /** The recipe given, or the one the device holds under this title. */
  async function resolveRecipe(args: { deviceId?: string; title: string; recipe?: z.input<typeof RecipeSchema> }) {
    if (args.recipe) return RecipeSchema.parse(args.recipe);
    if (!args.deviceId) throw new Error('Give the whole recipe, or a deviceId to read it from by profile title.');
    const settings = await snapshotProfile(fellow, { deviceId: args.deviceId, title: args.title });
    if (!settings)
      throw new Error(
        `No profile titled "${args.title}" is on the device in a readable shape, so its recipe is unknown. ` +
          'Pass the whole recipe instead.'
      );
    return recipeOf(settings);
  }

  server.registerTool(
    'storage.logBrew',
    {
      annotations: annotationsFor('storage.logBrew'),
      title: 'Log Brew Attempt',
      description:
        'Log a brew attempt with its whole recipe. Pass deviceId and the profile title, and the recipe ' +
        '(bloom and every single-serve and batch pulse step) is read from the profile with that title ' +
        'on the brewer. Or pass the recipe directly. The entry is what storage.restoreProfile ' +
        'recreates the profile from after it is deleted from the device.',
      inputSchema: {
        coffeeName: z.string().describe('Name of the coffee'),
        roaster: z.string().optional().describe('Roaster name'),
        origin: z.string().optional().describe('Coffee origin (e.g., Ethiopia, Colombia)'),
        roast: z.string().optional().describe('Roast level (light, medium, dark)'),
        processing: z.string().optional().describe('Processing method (washed, natural, honey)'),
        deviceId: ResourceIdSchema.optional().describe('Device the profile is on, to read its recipe'),
        profileTitle: z.string().describe('Exact title of the profile brewed, as aiden.listProfiles shows it'),
        recipe: RecipeInputSchema
      },
      outputSchema: { ok: z.boolean(), brewId: z.string(), message: z.string() }
    },
    async (args) => {
      const recipe = await resolveRecipe({ deviceId: args.deviceId, title: args.profileTitle, recipe: args.recipe });
      const entry = await logBrew({
        coffee: {
          name: args.coffeeName,
          roaster: args.roaster,
          origin: args.origin,
          roast: args.roast,
          processing: args.processing
        },
        profile: { title: args.profileTitle, recipe }
      });
      return toolResponse({ ok: true, brewId: entry.id, message: 'Brew logged. Ask for feedback after tasting!' });
    }
  );

  server.registerTool(
    'storage.completeRecipe',
    {
      annotations: annotationsFor('storage.completeRecipe'),
      title: 'Complete a Logged Recipe',
      description:
        'Give a brew logged with only ratio and bloom (`partial: true`) its whole recipe, keeping its ' +
        'coffee, time and feedback. Pass deviceId to read the recipe from the profile with the ' +
        "entry's title, or pass the recipe directly.",
      inputSchema: {
        brewId: z.string().describe('The brew to complete'),
        deviceId: ResourceIdSchema.optional().describe('Device holding the profile with the entry title'),
        recipe: RecipeInputSchema
      },
      outputSchema: { ok: z.boolean(), error: z.string().optional(), entry: BrewEntrySchema.optional() }
    },
    async ({ brewId, deviceId, recipe }) => {
      const existing = await getBrew(brewId);
      if (!existing) return toolResponse({ ok: false, error: 'Brew not found' });
      const full = await resolveRecipe({ deviceId, title: existing.profile.title, recipe });
      const entry = await completeRecipe(brewId, full);
      if (!entry) return toolResponse({ ok: false, error: 'Brew not found' });
      return toolResponse({ ok: true, entry });
    }
  );

  server.registerTool(
    'storage.restoreProfile',
    {
      annotations: annotationsFor('storage.restoreProfile'),
      title: 'Restore Profile From History',
      description:
        'Recreate a deleted profile on the brewer from the whole recipe recorded in brew history. ' +
        'Name a brewId, or a query (coffee name, roaster, origin or profile title) to use the ' +
        'best-rated matching brew. Profiles are named by title: a Custom profile with the same title ' +
        'already on the device is reported instead of duplicated. Optionally override the title.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        brewId: z.string().optional().describe('Brew to restore from'),
        query: z.string().optional().describe('Search brew history and restore the best-rated match'),
        title: z.string().optional().describe('Title for the restored profile, if not the archived one')
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        title: z.string().optional(),
        brewId: z.string().optional(),
        alreadyOnDevice: z.boolean().optional()
      }
    },
    async (args) => {
      const result = await restoreProfile(fellow, args);
      if (!result)
        return toolResponse({
          ok: false,
          error:
            'No logged brew with a whole recipe matches. Entries marked partial can be completed with storage.completeRecipe first.'
        });
      return toolResponse({
        ok: true,
        title: result.title,
        brewId: result.brew.id,
        alreadyOnDevice: result.alreadyOnDevice
      });
    }
  );

  server.registerTool(
    'storage.addFeedback',
    {
      annotations: annotationsFor('storage.addFeedback'),
      title: 'Add Brew Feedback',
      description: 'Add feedback to a logged brew (rating, taste notes).',
      inputSchema: {
        brewId: z.string().describe('The brew ID from storage.logBrew'),
        rating: z.int().min(1).max(5).describe('Rating 1-5 (1=terrible, 5=perfect)'),
        taste: z.string().optional().describe('Taste issue: sour, bitter, weak, harsh, perfect, etc.'),
        notes: z.string().optional().describe('Additional notes')
      },
      outputSchema: { ok: z.boolean(), error: z.string().optional(), entry: BrewEntrySchema.optional() }
    },
    async ({ brewId, rating, taste, notes }) => {
      // Zod validates rating is 1-5, cast is safe
      const entry = await addFeedback(brewId, { rating: rating as 1 | 2 | 3 | 4 | 5, taste, notes });
      if (!entry) return toolResponse({ ok: false, error: 'Brew not found' });
      return toolResponse({ ok: true, entry });
    }
  );

  server.registerTool(
    'storage.getHistory',
    {
      annotations: annotationsFor('storage.getHistory'),
      title: 'Get Brew History',
      description:
        'Get recent brew history with feedback. Each entry holds the whole recipe brewed; `partial: true` marks older entries that recorded only ratio and bloom.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe('Max entries to return') },
      outputSchema: { ok: z.boolean(), count: z.number(), entries: z.array(BrewEntrySchema) }
    },
    async ({ limit }) => {
      const entries = await getRecentBrews(limit);
      return toolResponse({ ok: true, count: entries.length, entries });
    }
  );

  server.registerTool(
    'storage.search',
    {
      annotations: annotationsFor('storage.search'),
      title: 'Search Brew History',
      description:
        'Search brew history by coffee name, roaster, origin or profile title. Entries carry their whole recipe.',
      inputSchema: { query: z.string().describe('Search term') },
      outputSchema: { ok: z.boolean(), count: z.number(), entries: z.array(BrewEntrySchema) }
    },
    async ({ query }) => {
      const entries = await searchBrews(query);
      return toolResponse({ ok: true, count: entries.length, entries });
    }
  );

  server.registerTool(
    'storage.findSimilar',
    {
      annotations: annotationsFor('storage.findSimilar'),
      title: 'Find Similar Brews',
      description: 'Find past brews with similar coffee characteristics, each with its whole recipe.',
      inputSchema: {
        origin: z.string().optional().describe('Coffee origin'),
        roast: z.string().optional().describe('Roast level'),
        processing: z.string().optional().describe('Processing method')
      },
      outputSchema: { ok: z.boolean(), count: z.number(), entries: z.array(BrewEntrySchema) }
    },
    async (args) => {
      const entries = await getSimilarBrews(args);
      return toolResponse({ ok: true, count: entries.length, entries });
    }
  );

  server.registerTool(
    'user.getSettings',
    {
      annotations: annotationsFor('user.getSettings'),
      title: 'Get User Settings',
      description: 'Get saved user preferences (grinder, default device, etc.).',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), settings: UserSettingsSchema }
    },
    async () => {
      const settings = await getSettings();
      return toolResponse({ ok: true, settings });
    }
  );

  server.registerTool(
    'user.updateSettings',
    {
      annotations: annotationsFor('user.updateSettings'),
      title: 'Update User Settings',
      description: 'Save user preferences for future sessions.',
      inputSchema: {
        grinder: z.string().optional().describe('Grinder model (e.g., "Comandante C40", "Fellow Ode Gen 2")'),
        defaultDeviceId: z.string().optional().describe('Default Aiden device ID'),
        preferredRatio: z.number().optional().describe('Preferred brew ratio (e.g., 16 for 1:16)'),
        elevation: z.number().optional().describe('Elevation in meters (affects boiling point)'),
        notes: z.string().optional().describe('Any other preferences')
      },
      outputSchema: { ok: z.boolean(), settings: UserSettingsSchema }
    },
    async (args) => {
      const settings = await updateSettings(args);
      return toolResponse({ ok: true, settings });
    }
  );
}
