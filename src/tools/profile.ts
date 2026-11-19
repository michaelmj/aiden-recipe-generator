import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { AidenCreateProfileSchema, AidenUpdateProfileSchema, ResourceIdSchema } from '@/schemas';
import { toolResponse } from '@/tools/response';

/** Exact title of a profile on the device, as aiden.listProfiles shows it. */
const ProfileTitleSchema = z.string().min(1).max(120).describe('Exact profile title, as aiden.listProfiles shows it');

const ProfileOutputSchema = z.object({
  /** Fellow's slot index for the profile; reused after a delete, so never a way to name one. */
  id: z.string(),
  title: z.string(),
  folder: z.enum(['Custom', 'Fellow', 'Drops', 'Unknown']),
  ratio: z.number(),
  bloomEnabled: z.boolean(),
  bloomRatio: z.number(),
  bloomDuration: z.number(),
  bloomTemperature: z.number(),
  ssPulsesEnabled: z.boolean(),
  ssPulsesNumber: z.number(),
  ssPulsesInterval: z.number(),
  ssPulseTemperatures: z.array(z.number()),
  batchPulsesEnabled: z.boolean(),
  batchPulsesNumber: z.number(),
  batchPulsesInterval: z.number().nullable(),
  batchPulseTemperatures: z.array(z.number()),
  // Present when the device reported something this client would not vouch for; see toProfile.
  anomalies: z.array(z.string()).optional()
});

export function registerProfileTools(server: McpServer, fellow: FellowClient) {
  server.registerTool(
    'aiden.listProfiles',
    {
      title: 'List Brew Profiles',
      description:
        'List brew profiles for a device. Name a profile by its title in every other tool: ids are ' +
        'slots the device reuses after a delete. A profile carrying an `anomalies` list reported values ' +
        'outside what the brewer can do, or a title that had to be trimmed — check those fields ' +
        'before brewing from them rather than passing them on as advice.',
      inputSchema: { deviceId: ResourceIdSchema },
      outputSchema: { profiles: z.array(ProfileOutputSchema) }
    },
    async ({ deviceId }) => toolResponse({ profiles: await fellow.listProfiles({ deviceId }) })
  );

  server.registerTool(
    'aiden.createProfile',
    {
      title: 'Create Brew Profile',
      description:
        'Create a new Custom profile on the device. Profiles are named by title, so a title already ' +
        'used by a Custom profile on the device is refused; update that profile instead.',
      inputSchema: { deviceId: ResourceIdSchema, profile: AidenCreateProfileSchema },
      outputSchema: { ok: z.boolean(), title: z.string() }
    },
    async ({ deviceId, profile }) => {
      await fellow.createProfile({ deviceId, profile });
      return toolResponse({ ok: true, title: profile.title });
    }
  );

  server.registerTool(
    'aiden.updateProfile',
    {
      title: 'Update Brew Profile',
      description:
        'Patch the Custom profile with this exact title, changing at least one field. Refused when no ' +
        'Custom profile or more than one has the title, and for Drops/Fellow defaults.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        title: ProfileTitleSchema,
        patch: AidenUpdateProfileSchema
      },
      outputSchema: { ok: z.boolean(), title: z.string() }
    },
    async ({ deviceId, title, patch }) => {
      await fellow.updateProfile({ deviceId, title, patch });
      return toolResponse({ ok: true, title: patch.title ?? title });
    }
  );

  server.registerTool(
    'aiden.deleteProfile',
    {
      title: 'Delete Brew Profile',
      description:
        'Delete the Custom profile with this exact title. Refused when no Custom profile or more than one has the title.',
      inputSchema: { deviceId: ResourceIdSchema, title: ProfileTitleSchema },
      outputSchema: { ok: z.boolean() }
    },
    async ({ deviceId, title }) => {
      await fellow.deleteProfile({ deviceId, title });
      return toolResponse({ ok: true });
    }
  );
}
