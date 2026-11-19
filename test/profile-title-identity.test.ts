/**
 * Profiles are named by title, never by device id (aiden-recipe-generator-46y.1).
 *
 * Fellow profile ids are slot indexes reused after a delete: p9 was Alinea - Colombia, then
 * Elevator - Arsosala. The operator deletes profiles once a coffee is gone, so anything keyed on
 * an id would later hit the wrong coffee. Every write resolves the title at call time and refuses
 * a missing or ambiguous one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FellowClient } from '@/fellow/client';
import { type Session, SessionStore } from '@/fellow/session';
import { createMcpServer, createServices } from '@/server';
import { logBrew } from '@/storage/brewLog';
import { restoreProfile, snapshotProfile } from '@/storage/profileArchive';
import { registerStorageTools } from '@/tools/storage';
import { freshDataDir, respondWith, withFetch } from './helpers/offline';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const RECIPE = {
  ratio: 17,
  bloomEnabled: true,
  bloomRatio: 3,
  bloomDuration: 45,
  bloomTemperature: 98,
  ssPulsesEnabled: true,
  ssPulsesNumber: 3,
  ssPulsesInterval: 23,
  ssPulseTemperatures: [98, 97, 96],
  batchPulsesEnabled: true,
  batchPulsesNumber: 1,
  batchPulsesInterval: 30,
  batchPulseTemperatures: [96]
};

const profile = (id: string, title: string, folder = 'Custom') => ({ id, title, folder, ...RECIPE });

async function loggedInClient(): Promise<FellowClient> {
  freshDataDir();
  process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';
  const session: Session = { email: 'someone@example.com', accessToken: 'token', obtainedAtMs: Date.now() };
  await new SessionStore().write(session);
  return new FellowClient();
}

/** A stub device: GET lists `profiles`; every other call is recorded as "METHOD path". */
function fakeDevice(profiles: unknown[]) {
  const writes: string[] = [];
  const fetch = respondWith((url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return jsonResponse(profiles);
    writes.push(`${method} ${new URL(url).pathname}`);
    return method === 'POST' ? jsonResponse({ id: 'p12' }) : new Response(null, { status: 204 });
  });
  return { fetch, writes };
}

afterEach(() => {
  delete process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION;
});

describe('writes resolve the title at call time', () => {
  test('update and delete hit the slot that holds the title now', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([profile('p3', 'Morning Filter'), profile('p9', 'Elevator - Arsosala')]);
    await withFetch(device.fetch, async () => {
      await client.updateProfile({ deviceId: 'dev1', title: 'Elevator - Arsosala', patch: { ratio: 16 } });
      await client.deleteProfile({ deviceId: 'dev1', title: 'Morning Filter' });
    });
    expect(device.writes).toEqual(['PATCH /v1/devices/dev1/profiles/p9', 'DELETE /v1/devices/dev1/profiles/p3']);
  });

  test('a coffee whose slot was reused cannot be updated, deleted or archived through it', async () => {
    // Alinea - Colombia lived in p9; it was deleted and p9 now holds Elevator - Arsosala.
    const client = await loggedInClient();
    const device = fakeDevice([profile('p9', 'Elevator - Arsosala')]);
    await withFetch(device.fetch, async () => {
      await expect(
        client.updateProfile({ deviceId: 'dev1', title: 'Alinea - Colombia', patch: { ratio: 16 } })
      ).rejects.toThrow(/No profile titled "Alinea - Colombia".*"Elevator - Arsosala"/);
      await expect(client.deleteProfile({ deviceId: 'dev1', title: 'Alinea - Colombia' })).rejects.toThrow(
        /No profile titled/
      );
      expect(await snapshotProfile(client, { deviceId: 'dev1', title: 'Alinea - Colombia' })).toBeUndefined();
    });
    expect(device.writes).toEqual([]);
  });

  test('restoring a coffee whose old slot was reused creates it rather than reusing the slot', async () => {
    const client = await loggedInClient();
    // Logged before 46y.1, with the slot id of the time.
    await logBrew({
      coffee: { name: 'Alinea - Colombia' },
      profile: {
        id: 'p9',
        title: 'Alinea - Colombia',
        ratio: 17,
        bloomTemp: 98,
        bloomDuration: 45,
        settings: { profileType: 0, title: 'Alinea - Colombia', ...RECIPE }
      }
    });
    const device = fakeDevice([profile('p9', 'Elevator - Arsosala')]);
    const result = await withFetch(device.fetch, () => restoreProfile(client, { deviceId: 'dev1', query: 'Alinea' }));
    expect(result).toMatchObject({ title: 'Alinea - Colombia', alreadyOnDevice: false });
    expect(device.writes).toEqual(['POST /v1/devices/dev1/profiles']);
  });
});

describe('ambiguous titles are refused', () => {
  const twins = [profile('p2', 'House Blend'), profile('p5', 'House Blend')];

  test('two Custom profiles with one title block update, delete, archive and restore', async () => {
    const client = await loggedInClient();
    await logBrew({
      coffee: { name: 'House Blend' },
      profile: {
        title: 'House Blend',
        ratio: 17,
        bloomTemp: 98,
        bloomDuration: 45,
        settings: { profileType: 0, title: 'House Blend', ...RECIPE }
      }
    });
    const device = fakeDevice(twins);
    await withFetch(device.fetch, async () => {
      await expect(
        client.updateProfile({ deviceId: 'dev1', title: 'House Blend', patch: { ratio: 16 } })
      ).rejects.toThrow(/2 Custom profiles are titled "House Blend"/);
      await expect(client.deleteProfile({ deviceId: 'dev1', title: 'House Blend' })).rejects.toThrow(/ambiguous/);
      await expect(snapshotProfile(client, { deviceId: 'dev1', title: 'House Blend' })).rejects.toThrow(/ambiguous/);
      await expect(restoreProfile(client, { deviceId: 'dev1', query: 'House Blend' })).rejects.toThrow(/ambiguous/);
    });
    expect(device.writes).toEqual([]);
  });

  test('create refuses a title a Custom profile already has', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([profile('p2', 'House Blend')]);
    await expect(
      withFetch(device.fetch, () =>
        client.createProfile({ deviceId: 'dev1', profile: { profileType: 0, title: 'House Blend', ...RECIPE } })
      )
    ).rejects.toThrow(/already on this device/);
    expect(device.writes).toEqual([]);
  });

  test('create allows a title only a Fellow default has', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([profile('f1', 'House Blend', 'Fellow')]);
    await withFetch(device.fetch, () =>
      client.createProfile({ deviceId: 'dev1', profile: { profileType: 0, title: 'House Blend', ...RECIPE } })
    );
    expect(device.writes).toEqual(['POST /v1/devices/dev1/profiles']);
  });

  test('a rename onto another Custom profile title is refused', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([profile('p2', 'House Blend'), profile('p3', 'Morning Filter')]);
    await expect(
      withFetch(device.fetch, () =>
        client.updateProfile({ deviceId: 'dev1', title: 'Morning Filter', patch: { title: 'House Blend' } })
      )
    ).rejects.toThrow(/already on this device/);
    expect(device.writes).toEqual([]);
  });
});

describe('the tool surface', () => {
  async function connect(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  test('no tool or prompt takes a profile id', async () => {
    freshDataDir();
    const client = await connect(createMcpServer(createServices()));
    const { tools } = await client.listTools();
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('profileId');
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) expect((prompt.arguments ?? []).map((arg) => arg.name)).not.toContain('profileId');
  });

  test('history never shows the legacy slot id of old entries', async () => {
    freshDataDir();
    await logBrew({
      coffee: { name: 'Alinea - Colombia' },
      profile: { id: 'p9', title: 'Alinea - Colombia', ratio: 17, bloomTemp: 98, bloomDuration: 45 }
    });
    const server = new McpServer({ name: 'test', version: '0' });
    registerStorageTools(server, {} as FellowClient);
    const client = await connect(server);
    const result = await client.callTool({ name: 'storage.getHistory', arguments: {} });
    const entries = (result.structuredContent as { entries: Array<{ profile: Record<string, unknown> }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.profile.title).toBe('Alinea - Colombia');
    expect(entries[0]?.profile).not.toHaveProperty('id');
  });
});
