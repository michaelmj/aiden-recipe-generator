import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { AidenCreateProfileSchema, AidenUpdateProfileSchema, ResourceIdSchema } from '@/schemas';
import { toolResponse } from '@/tools/response';

const ProfileOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.enum(['Custom', 'Fellow', 'Drops']),
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
  batchPulseTemperatures: z.array(z.number())
});

export function registerProfileTools(server: McpServer, fellow: FellowClient) {
  server.registerTool(
    'aiden.listProfiles',
    {
      title: 'List Brew Profiles',
      description: 'List brew profiles for a device.',
      inputSchema: { deviceId: ResourceIdSchema },
      outputSchema: { profiles: z.array(ProfileOutputSchema) }
    },
    async ({ deviceId }) => toolResponse({ profiles: await fellow.listProfiles({ deviceId }) })
  );

  server.registerTool(
    'aiden.createProfile',
    {
      title: 'Create Brew Profile',
      description: 'Create a new profile on the device.',
      inputSchema: { deviceId: ResourceIdSchema, profile: AidenCreateProfileSchema },
      outputSchema: { ok: z.boolean(), id: z.string().optional() }
    },
    async ({ deviceId, profile }) => {
      const result = await fellow.createProfile({ deviceId, profile });
      return toolResponse({ ok: true, id: result?.id as string | undefined });
    }
  );

  server.registerTool(
    'aiden.updateProfile',
    {
      title: 'Update Brew Profile',
      description: 'Patch an existing Custom profile. This should not be used for Drops/Fellow defaults.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        profileId: ResourceIdSchema,
        patch: AidenUpdateProfileSchema
      },
      outputSchema: { ok: z.boolean() }
    },
    async ({ deviceId, profileId, patch }) => {
      await fellow.updateProfile({ deviceId, profileId, patch });
      return toolResponse({ ok: true });
    }
  );

  server.registerTool(
    'aiden.deleteProfile',
    {
      title: 'Delete Brew Profile',
      description: 'Delete an existing Custom profile.',
      inputSchema: { deviceId: ResourceIdSchema, profileId: ResourceIdSchema },
      outputSchema: { ok: z.boolean() }
    },
    async ({ deviceId, profileId }) => {
      await fellow.deleteProfile({ deviceId, profileId });
      return toolResponse({ ok: true });
    }
  );
}
