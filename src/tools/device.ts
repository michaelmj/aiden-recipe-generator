import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { ResourceIdSchema } from '@/schemas';
import { toolResponse } from '@/tools/response';

const DeviceSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  serialNumber: z.string(),
  isConnected: z.boolean(),
  brewing: z.boolean(),
  brewingProfileId: z.string().nullable(),
  singleBrewBasketPresent: z.boolean(),
  batchBrewBasketPresent: z.boolean(),
  carafePresent: z.boolean(),
  lidClosed: z.boolean(),
  missingWater: z.boolean()
});

export function registerDeviceTools(server: McpServer, fellow: FellowClient) {
  server.registerTool(
    'aiden.listDevices',
    {
      title: 'List Aiden Devices',
      description: 'List devices from Fellow API.',
      inputSchema: { dataType: z.enum(['real', 'cached']).default('real') },
      outputSchema: { devices: z.array(DeviceSchema) }
    },
    async ({ dataType }) => toolResponse({ devices: await fellow.listDevices({ dataType }) })
  );

  server.registerTool(
    'aiden.getDevice',
    {
      title: 'Get Aiden Device',
      description: 'Get device details from Fellow API.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        dataType: z.enum(['real', 'cached']).default('real')
      },
      outputSchema: DeviceSchema
    },
    async ({ deviceId, dataType }) => toolResponse(await fellow.getDevice({ deviceId, dataType }))
  );
}
