/**
 * Storage Tools - MCP tools for brew history and user settings.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { type AidenCreateProfileInput, AidenCreateProfileSchema, ResourceIdSchema } from '@/schemas';
import { addFeedback, type BrewEntry, getRecentBrews, getSimilarBrews, logBrew, searchBrews } from '@/storage/brewLog';
import { restoreProfile, snapshotProfile } from '@/storage/profileArchive';
import { getSettings, type UserSettings, updateSettings } from '@/storage/userSettings';
import { toolResponse } from '@/tools/response';

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
  profile: z.object({
    id: z.string().optional(),
    title: z.string(),
    ratio: z.number(),
    bloomTemp: z.number(),
    bloomDuration: z.number(),
    settings: AidenCreateProfileSchema.optional()
  }),
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

export function registerStorageTools(server: McpServer, fellow: FellowClient) {
  server.registerTool(
    'storage.logBrew',
    {
      title: 'Log Brew Attempt',
      description:
        'Log a brew attempt for future reference. Pass deviceId and profileId and the full profile ' +
        'settings are read from the brewer and archived with the entry, so the profile can be ' +
        'restored with storage.restoreProfile after it is deleted from the device. Or pass the ' +
        'settings directly. ratio, bloomTemp and bloomDuration are only needed when neither is given.',
      inputSchema: {
        coffeeName: z.string().describe('Name of the coffee'),
        roaster: z.string().optional().describe('Roaster name'),
        origin: z.string().optional().describe('Coffee origin (e.g., Ethiopia, Colombia)'),
        roast: z.string().optional().describe('Roast level (light, medium, dark)'),
        processing: z.string().optional().describe('Processing method (washed, natural, honey)'),
        deviceId: ResourceIdSchema.optional().describe('Device the profile is on, to archive its full settings'),
        profileId: z.string().optional().describe('Profile ID used'),
        profileTitle: z.string().describe('Profile title'),
        settings: AidenCreateProfileSchema.optional().describe(
          'Full profile settings as brewed, when not reading them from the device'
        ),
        ratio: z.number().optional().describe('Brew ratio'),
        bloomTemp: z.number().optional().describe('Bloom temperature in Celsius'),
        bloomDuration: z.number().optional().describe('Bloom duration in seconds')
      },
      outputSchema: { ok: z.boolean(), brewId: z.string(), settingsArchived: z.boolean(), message: z.string() }
    },
    async (args) => {
      let settings: AidenCreateProfileInput | undefined = args.settings;
      let warning = '';
      if (!settings && args.deviceId && args.profileId) {
        try {
          settings = await snapshotProfile(fellow, {
            deviceId: args.deviceId,
            profileId: args.profileId,
            title: args.profileTitle
          });
          if (!settings)
            warning = ` Profile "${args.profileId}" titled "${args.profileTitle}" was not found on the device in a restorable shape, so full settings were not archived.`;
        } catch {
          warning = ' The device could not be read, so full settings were not archived.';
        }
      }
      const ratio = args.ratio ?? settings?.ratio;
      const bloomTemp = args.bloomTemp ?? settings?.bloomTemperature;
      const bloomDuration = args.bloomDuration ?? settings?.bloomDuration;
      if (ratio === undefined || bloomTemp === undefined || bloomDuration === undefined)
        throw new Error(
          'Give ratio, bloomTemp and bloomDuration, or the full settings, or a deviceId and profileId to read them from.'
        );
      const entry = await logBrew({
        coffee: {
          name: args.coffeeName,
          roaster: args.roaster,
          origin: args.origin,
          roast: args.roast,
          processing: args.processing
        },
        profile: { id: args.profileId, title: args.profileTitle, ratio, bloomTemp, bloomDuration, settings }
      });
      return toolResponse({
        ok: true,
        brewId: entry.id,
        settingsArchived: Boolean(entry.profile.settings),
        message: `Brew logged. Ask for feedback after tasting!${warning}`
      });
    }
  );

  server.registerTool(
    'storage.restoreProfile',
    {
      title: 'Restore Profile From History',
      description:
        'Recreate a deleted profile on the brewer from its archived settings in brew history. ' +
        'Name a brewId, or a query (coffee name, roaster, origin or profile title) to use the ' +
        'best-rated matching brew. A Custom profile with the same title already on the device is ' +
        'returned instead of duplicated. Optionally override the title.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        brewId: z.string().optional().describe('Brew to restore from'),
        query: z.string().optional().describe('Search brew history and restore the best-rated match'),
        title: z.string().optional().describe('Title for the restored profile, if not the archived one')
      },
      outputSchema: {
        ok: z.boolean(),
        error: z.string().optional(),
        profileId: z.string().optional(),
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
            'No logged brew with archived settings matches. Brews logged before settings were archived cannot be restored.'
        });
      return toolResponse({
        ok: true,
        profileId: result.profileId,
        title: result.title,
        brewId: result.brew.id,
        alreadyOnDevice: result.alreadyOnDevice
      });
    }
  );

  server.registerTool(
    'storage.addFeedback',
    {
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
      title: 'Get Brew History',
      description: 'Get recent brew history with feedback.',
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
      title: 'Search Brew History',
      description: 'Search brew history by coffee name, roaster, or origin.',
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
      title: 'Find Similar Brews',
      description: 'Find past brews with similar coffee characteristics.',
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
