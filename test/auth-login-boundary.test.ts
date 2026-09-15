import { afterEach, describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FellowClient } from '@/fellow/client';
import { registerAuthTools } from '@/tools/auth';

type Registered = { description: string; handler: (args: Record<string, string>) => Promise<unknown> };

function registeredAuthTools(): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: { description: string }, handler: Registered['handler']) {
      tools.set(name, { description: config.description, handler });
    }
  };
  const fellow = {
    login: async ({ email }: { email: string }) => ({ ok: true, email }),
    status: async () => ({ ok: true, loggedIn: false }),
    logout: async () => undefined
  };
  registerAuthTools(server as unknown as McpServer, fellow as unknown as FellowClient);
  return tools;
}

afterEach(() => delete process.env.AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN);

describe('Fellow credential entry boundary', () => {
  test('the default MCP surface has status/logout but no password-taking login tool', () => {
    delete process.env.AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN;
    expect([...registeredAuthTools().keys()]).toEqual(['auth.status', 'auth.logout']);
  });

  test('legacy MCP login requires an explicit insecure opt-in and warns in its description', () => {
    process.env.AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN = '1';
    const login = registeredAuthTools().get('auth.login');
    expect(login).toBeDefined();
    expect(login?.description).toMatch(/INSECURE OPT-IN/);
  });

  test('local login command does not accept password arguments', async () => {
    const source = await Bun.file(new URL('../src/cli/login.ts', import.meta.url)).text();
    expect(source).not.toMatch(/process\.argv\[[^\]]+\].*password/i);
    expect(source).toContain('setRawMode(true)');
    expect(source).toContain('setRawMode(false)');
  });
});
