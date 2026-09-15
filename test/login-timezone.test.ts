import { describe, expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FellowClient } from '@/fellow/client';
import { canonicalTimezone, hostTimezone, isValidTimezone, resolveLoginTimezone } from '@/fellow/timezone';
import { registerAuthTools } from '@/tools/auth';

type LoginArgs = { email: string; password: string; timezone: string };

/** Registers the opt-in login tool and returns its handler plus the args it forwards to Fellow. */
function insecureLoginTool() {
  const calls: LoginArgs[] = [];
  let handler: ((args: Record<string, string>) => Promise<unknown>) | undefined;
  let schema: { timezone: { safeParse: (value: unknown) => { success: boolean } } } | undefined;

  const server = {
    registerTool(name: string, config: { inputSchema?: typeof schema }, toolHandler: typeof handler) {
      if (name !== 'auth.login') return;
      handler = toolHandler;
      schema = config.inputSchema;
    }
  };
  const fellow = {
    login: async (args: LoginArgs) => {
      calls.push(args);
      return { ok: true, email: args.email };
    },
    status: async () => ({ ok: true, loggedIn: false }),
    logout: async () => undefined
  };

  process.env.AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN = '1';
  try {
    registerAuthTools(server as unknown as McpServer, fellow as unknown as FellowClient);
  } finally {
    delete process.env.AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN;
  }

  if (!handler || !schema) throw new Error('auth.login was not registered.');
  return { handler, schema, calls };
}

describe('login timezone resolution', () => {
  test('an explicit zone is used as given, in canonical form', () => {
    expect(resolveLoginTimezone('America/Detroit', () => 'Europe/Prague')).toBe('America/Detroit');
    expect(resolveLoginTimezone('Asia/Tokyo', () => 'Europe/Prague')).toBe('Asia/Tokyo');
    expect(resolveLoginTimezone('america/detroit', () => undefined)).toBe('America/Detroit');
  });

  test('without an explicit zone the host zone is used, never a fixed region', () => {
    expect(resolveLoginTimezone(undefined, () => 'America/Detroit')).toBe('America/Detroit');
    expect(resolveLoginTimezone(undefined, () => 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  test('an unavailable host zone demands an explicit value instead of a guess', () => {
    expect(() => resolveLoginTimezone(undefined, () => undefined)).toThrow(/explicit timezone/);
  });

  test('invalid zones are rejected, offsets and junk included', () => {
    for (const bad of ['', '   ', 'Not/A/Zone/At/All', '+05:00', '-0500', 'Europe/Prague; DROP']) {
      expect(isValidTimezone(bad)).toBe(false);
      expect(() => resolveLoginTimezone(bad, () => 'America/Detroit')).toThrow(/IANA zone name/);
    }
  });

  test('rejection does not echo the submitted value back into the transcript', () => {
    expect(() => resolveLoginTimezone('Totally/Bogus', () => undefined)).toThrow(
      new Error('timezone must be an IANA zone name such as America/Detroit.')
    );
  });

  test('the host zone, when reported, is a usable IANA name', () => {
    const host = hostTimezone();
    if (host !== undefined) expect(canonicalTimezone(host)).toBe(host);
  });
});

describe('auth.login timezone boundary', () => {
  test('no hard-coded region is submitted; the omitted zone resolves to the host zone', async () => {
    const source = await Bun.file(new URL('../src/tools/auth.ts', import.meta.url)).text();
    expect(source).not.toContain('Europe/Prague');

    const { handler, calls } = insecureLoginTool();
    await handler({ email: 'someone@example.com', password: 'pw' });
    expect(calls[0]?.timezone).toBe(hostTimezone() ?? '');
  });

  test('an explicit zone is forwarded and an invalid one is rejected by the schema', async () => {
    const { handler, schema, calls } = insecureLoginTool();
    await handler({ email: 'someone@example.com', password: 'pw', timezone: 'Asia/Tokyo' });
    expect(calls[0]?.timezone).toBe('Asia/Tokyo');

    expect(schema.timezone.safeParse('Europe/Prague').success).toBe(true);
    expect(schema.timezone.safeParse('Not/A/Zone').success).toBe(false);
    expect(schema.timezone.safeParse(undefined).success).toBe(true);
  });
});
