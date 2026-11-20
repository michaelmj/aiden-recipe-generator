/**
 * Every tool publishes reviewed MCP safety annotations (aiden-recipe-generator-9jr).
 *
 * The contract is checked on what tools/list actually sends, so a new tool registered without
 * annotations fails here even if it never touches src/tools/annotations.ts. The expected table is
 * spelled out rather than imported, so changing a tool's classification takes a deliberate edit
 * to this test as well.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer, createServices } from '@/server';
import { TOOL_ANNOTATIONS } from '@/tools/annotations';
import { INSECURE_MCP_LOGIN_ENV } from '@/tools/auth';

import { freshDataDir } from './helpers/offline';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** [readOnly, destructive, idempotent, openWorld] */
type Row = readonly [boolean, boolean, boolean, boolean];

const EXPECTED: Record<string, Row> = {
  'auth.login': [false, false, true, true],
  'auth.status': [true, false, true, false],
  'auth.logout': [false, true, true, false],
  'aiden.listDevices': [true, false, true, true],
  'aiden.getDevice': [true, false, true, true],
  'aiden.listProfiles': [true, false, true, true],
  'aiden.createProfile': [false, false, true, true],
  'aiden.updateProfile': [false, true, true, true],
  'aiden.deleteProfile': [false, true, true, true],
  'recipe.validateProposal': [true, false, true, false],
  'recipe.previewProposal': [false, false, false, false],
  'recipe.applyProposal': [false, false, true, true],
  'recipe.cancelProposalReview': [false, false, true, false],
  'sheet.sync': [false, false, true, true],
  'sheet.list': [true, false, true, true],
  'sheet.search': [true, false, true, true],
  'storage.logBrew': [false, false, false, true],
  'storage.completeRecipe': [false, true, true, true],
  'storage.restoreProfile': [false, false, true, true],
  'storage.addFeedback': [false, true, true, false],
  'storage.getHistory': [true, false, true, false],
  'storage.search': [true, false, true, false],
  'storage.findSimilar': [true, false, true, false],
  'user.getSettings': [true, false, true, false],
  'user.updateSettings': [false, true, true, false]
};

async function listTools(): Promise<Tool[]> {
  freshDataDir();
  const server = createMcpServer(createServices());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotations-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

afterEach(() => {
  delete process.env[INSECURE_MCP_LOGIN_ENV];
});

describe('tool safety annotations', () => {
  // The opt-in login tool is registered too, so it is held to the same contract.
  async function allTools(): Promise<Tool[]> {
    process.env[INSECURE_MCP_LOGIN_ENV] = '1';
    return listTools();
  }

  test('every listed tool declares all four hints as booleans', async () => {
    const tools = await allTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const hint of HINTS) {
        expect({ tool: tool.name, hint, type: typeof tool.annotations?.[hint] }).toEqual({
          tool: tool.name,
          hint,
          type: 'boolean'
        });
      }
    }
  });

  test('every listed tool matches its reviewed classification', async () => {
    const tools = await allTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const tool of tools) {
      const actual = HINTS.map((hint) => tool.annotations?.[hint]);
      expect({ tool: tool.name, hints: actual }).toEqual({ tool: tool.name, hints: [...(EXPECTED[tool.name] ?? [])] });
    }
  });

  test('the annotation table has no entry for a tool that does not exist', async () => {
    const names = new Set((await allTools()).map((t) => t.name));
    for (const name of Object.keys(TOOL_ANNOTATIONS)) expect(names.has(name)).toBe(true);
  });

  test('read-only tools never claim to be destructive', () => {
    for (const [name, hints] of Object.entries(TOOL_ANNOTATIONS)) {
      if (hints.readOnlyHint)
        expect({ name, destructive: hints.destructiveHint }).toEqual({ name, destructive: false });
    }
  });

  test('every tool that deletes or overwrites user state is marked destructive', () => {
    for (const name of [
      'aiden.deleteProfile',
      'aiden.updateProfile',
      'auth.logout',
      'storage.addFeedback',
      'storage.completeRecipe',
      'user.updateSettings'
    ] as const) {
      expect({ name, ...TOOL_ANNOTATIONS[name] }).toMatchObject({ name, readOnlyHint: false, destructiveHint: true });
    }
  });

  test('without the opt-in, auth.login is absent but every other tool is still annotated', async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name)).not.toContain('auth.login');
    for (const tool of tools) for (const hint of HINTS) expect(typeof tool.annotations?.[hint]).toBe('boolean');
  });
});
