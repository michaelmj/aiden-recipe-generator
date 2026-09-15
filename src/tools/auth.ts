import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { toolResponse } from '@/tools/response';

export const INSECURE_MCP_LOGIN_ENV = 'AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN';

export function insecureMcpLoginEnabled(): boolean {
  return process.env[INSECURE_MCP_LOGIN_ENV]?.trim() === '1';
}

export function registerAuthTools(server: McpServer, fellow: FellowClient) {
  if (insecureMcpLoginEnabled()) {
    server.registerTool(
      'auth.login',
      {
        title: 'Insecure Fellow Login Compatibility Tool',
        description:
          'INSECURE OPT-IN: sends the Fellow password through the MCP request/transcript. Prefer `bun run auth:login` in a local terminal.',
        inputSchema: {
          email: z.string().email(),
          password: z.string().min(1),
          timezone: z.string().default('Europe/Prague')
        },
        outputSchema: {
          ok: z.boolean(),
          email: z.string()
        }
      },
      async ({ email, password, timezone }) => toolResponse(await fellow.login({ email, password, timezone }))
    );
  }

  server.registerTool(
    'auth.status',
    {
      title: 'Auth Status',
      description: 'Check if the MCP server has a stored Fellow session.',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), loggedIn: z.boolean(), email: z.string().optional() }
    },
    async () => toolResponse(await fellow.status())
  );

  server.registerTool(
    'auth.logout',
    {
      title: 'Logout',
      description: 'Clear stored Fellow session.',
      inputSchema: {},
      outputSchema: { ok: z.boolean() }
    },
    async () => {
      await fellow.logout();
      return toolResponse({ ok: true });
    }
  );
}
