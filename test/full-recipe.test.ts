/**
 * A recipe is the whole brew, everywhere it is stored or shown (aiden-recipe-generator-46y.2).
 *
 * The brew log, recipe search and proposals all carry one shape — RecipeSchema: bloom (enabled,
 * ratio, duration, temperature) and the single-serve and batch pulse steps (enabled, count,
 * interval, per-pulse temperatures). Entries logged before that keep loading, marked partial.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FellowClient } from '@/fellow/client';
import { type Session, SessionStore } from '@/fellow/session';
import { RecipeSchema } from '@/schemas';
import { addFeedback, getRecentBrews, getSimilarBrews, logBrew, searchBrews } from '@/storage/brewLog';
import { registerStorageTools } from '@/tools/storage';
import { legacyEntry, writeRawBrewLog } from './helpers/brewLog';
import { freshDataDir, respondWith, withFetch } from './helpers/offline';
import { captureTools, datasetOf, freshStore } from './helpers/sheet';

const RECIPE = RecipeSchema.parse({
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
});

const ON_DEVICE = { id: 'p9', title: 'Elevator - Arsosala', folder: 'Custom', ...RECIPE };

afterEach(() => {
  delete process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION;
});

async function loggedInClient(): Promise<FellowClient> {
  freshDataDir();
  process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';
  const session: Session = { email: 'someone@example.com', accessToken: 'token', obtainedAtMs: Date.now() };
  await new SessionStore().write(session);
  return new FellowClient();
}

async function storageClient(fellow: FellowClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0' });
  registerStorageTools(server, fellow);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const device = respondWith(
  () => new Response(JSON.stringify([ON_DEVICE]), { status: 200, headers: { 'content-type': 'application/json' } })
);

describe('the brew log stores the whole recipe', () => {
  test('history, search and findSimilar return bloom and both pulse schedules', async () => {
    freshDataDir();
    await logBrew({
      coffee: { name: 'Elevator - Arsosala', origin: 'Ethiopia', roast: 'light' },
      profile: { title: 'Elevator - Arsosala', recipe: RECIPE }
    });
    for (const entries of [
      await getRecentBrews(),
      await searchBrews('arsosala'),
      await getSimilarBrews({ origin: 'Ethiopia' })
    ]) {
      expect(entries).toHaveLength(1);
      expect(entries[0]?.profile).toEqual({ title: 'Elevator - Arsosala', recipe: RECIPE });
    }
  });

  test('a summary alone is not a recipe', async () => {
    freshDataDir();
    await expect(
      logBrew({
        coffee: { name: 'Summary only' },
        profile: { title: 'Summary only', recipe: { ratio: 16, bloomTemperature: 95, bloomDuration: 45 } as never }
      })
    ).rejects.toThrow();
  });

  test('logBrew reads the recipe from the device by title', async () => {
    const client = await storageClient(await loggedInClient());
    await withFetch(device, () =>
      client.callTool({
        name: 'storage.logBrew',
        arguments: { coffeeName: 'Arsosala', deviceId: 'dev1', profileTitle: 'Elevator - Arsosala' }
      })
    );
    expect((await getRecentBrews())[0]?.profile).toEqual({ title: 'Elevator - Arsosala', recipe: RECIPE });
  });

  test('logBrew refuses rather than logging without a recipe', async () => {
    const client = await storageClient(await loggedInClient());
    const result = await withFetch(device, () =>
      client.callTool({
        name: 'storage.logBrew',
        arguments: { coffeeName: 'Gone', deviceId: 'dev1', profileTitle: 'Alinea - Colombia' }
      })
    );
    expect(result.isError).toBe(true);
    expect(await getRecentBrews()).toEqual([]);
  });
});

describe('entries logged before full recipes', () => {
  test('load, flagged partial, with the ratio and bloom they kept and no slot id', async () => {
    writeRawBrewLog(freshDataDir(), [legacyEntry('brew-old', 'Alinea - Colombia')]);
    const [entry] = await getRecentBrews();
    expect(entry?.profile).toEqual({
      title: 'Alinea - Colombia',
      partial: true,
      recipe: { ratio: 16, bloomTemperature: 95, bloomDuration: 45 }
    });
  });

  test('ones that archived settings become full entries', async () => {
    writeRawBrewLog(freshDataDir(), [
      legacyEntry('brew-archived', 'Elevator - Arsosala', {
        ratio: 17,
        bloomTemp: 98,
        settings: { profileType: 0, title: 'Elevator - Arsosala', ...RECIPE }
      })
    ]);
    expect((await getRecentBrews())[0]?.profile).toEqual({ title: 'Elevator - Arsosala', recipe: RECIPE });
  });

  test('the next write migrates the file and keeps feedback', async () => {
    const dir = freshDataDir();
    writeRawBrewLog(dir, [legacyEntry('brew-old', 'Alinea - Colombia')]);
    await addFeedback('brew-old', { rating: 4 });
    const onDisk = JSON.parse(readFileSync(join(dir, 'brew-log.json'), 'utf8'));
    expect(onDisk.entries[0].profile).toEqual({
      title: 'Alinea - Colombia',
      partial: true,
      recipe: { ratio: 16, bloomTemperature: 95, bloomDuration: 45 }
    });
    expect(onDisk.entries[0].feedback).toEqual({ rating: 4 });
  });

  test('storage.completeRecipe fills one in from the device, keeping its time and feedback', async () => {
    const fellow = await loggedInClient();
    writeRawBrewLog(process.env.AIDEN_AI_DATA_DIR as string, [
      { ...legacyEntry('brew-old', 'Elevator - Arsosala'), feedback: { rating: 4, notes: 'Grind 4' } }
    ]);
    const client = await storageClient(fellow);
    const result = await withFetch(device, () =>
      client.callTool({ name: 'storage.completeRecipe', arguments: { brewId: 'brew-old', deviceId: 'dev1' } })
    );
    expect(result.isError).toBeFalsy();
    const [entry] = await getRecentBrews();
    expect(entry).toMatchObject({
      id: 'brew-old',
      timestamp: 1_794_068_506_788,
      profile: { title: 'Elevator - Arsosala', recipe: RECIPE },
      feedback: { rating: 4, notes: 'Grind 4' }
    });
    expect(entry?.profile).not.toHaveProperty('partial');
  });
});

describe('recipe search returns the same recipe shape', () => {
  const COMPLETE = {
    id: 'crimson-purple-honey',
    source: { kind: 'first-party' as const },
    title: 'Crimson Purple Honey',
    brewRatio: '15',
    bloomRatio: '3',
    bloomTime: '45',
    bloomTemp: '95',
    ssPulsesNumber: '3',
    ssPulsesInterval: '23',
    ssPulseTemps: '95,94,93',
    batchPulsesNumber: '1',
    batchPulseTemps: '93'
  };
  const INCOMPLETE = {
    id: 'ratio-only',
    source: { kind: 'first-party' as const },
    title: 'Ratio Only',
    brewRatio: '16'
  };

  test('complete records carry recipe; incomplete ones say partial', async () => {
    freshDataDir();
    const tools = captureTools(datasetOf([COMPLETE, INCOMPLETE]), freshStore());
    const res = await tools.get('sheet.search')?.handler({ limit: 20 });
    if (!res) throw new Error('sheet.search was not registered');
    const [complete, incomplete] = res.structuredContent.profiles as Array<Record<string, unknown>>;
    expect(complete?.recipe).toEqual({
      ratio: 15,
      bloomEnabled: true,
      bloomRatio: 3,
      bloomDuration: 45,
      bloomTemperature: 95,
      ssPulsesEnabled: true,
      ssPulsesNumber: 3,
      ssPulsesInterval: 23,
      ssPulseTemperatures: [95, 94, 93],
      batchPulsesEnabled: true,
      batchPulsesNumber: 1,
      batchPulsesInterval: 30,
      batchPulseTemperatures: [93]
    });
    expect(complete).not.toHaveProperty('partial');
    expect(incomplete?.partial).toBe(true);
    expect(incomplete).not.toHaveProperty('recipe');
  });
});
