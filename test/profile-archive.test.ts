/**
 * Retired profiles stay recoverable from brew history (aiden-recipe-generator-3ha).
 *
 * The operator deletes profiles once a coffee is gone and Fellow reuses their ids, so the brew log
 * archives every writable setting and storage.restoreProfile writes them back.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { FellowClient } from '@/fellow/client';
import { type Session, SessionStore } from '@/fellow/session';
import { evidenceFromBrewHistory } from '@/recipes/proposal';
import { addFeedback, findRestorableBrew, logBrew } from '@/storage/brewLog';
import { restoreProfile, settingsFromDeviceProfile, snapshotProfile } from '@/storage/profileArchive';
import { freshDataDir, respondWith, withFetch } from './helpers/offline';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const DEVICE_PROFILE = {
  id: 'p9',
  title: 'Elevator - Arsosala',
  folder: 'Custom',
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

const { id: _id, folder: _folder, ...SETTINGS } = DEVICE_PROFILE;

async function loggedInClient(): Promise<FellowClient> {
  freshDataDir();
  process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';
  const session: Session = { email: 'someone@example.com', accessToken: 'token', obtainedAtMs: Date.now() };
  await new SessionStore().write(session);
  return new FellowClient();
}

/** A stub Fellow API: GET lists `profiles`, POST records the body and answers a new id. */
function fakeDevice(profiles: unknown[]) {
  const posted: unknown[] = [];
  const fetch = respondWith((_url, init) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return jsonResponse({ id: 'p12' });
    }
    return jsonResponse(profiles);
  });
  return { fetch, posted };
}

const coffee = (name: string) => ({ name, roaster: 'Elevator Coffee', origin: 'Ethiopia' });

afterEach(() => {
  delete process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION;
});

describe('archiving settings on logBrew', () => {
  test('reads full settings from the device by title', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([DEVICE_PROFILE]);
    const settings = await withFetch(device.fetch, () =>
      snapshotProfile(client, { deviceId: 'dev1', title: 'Elevator - Arsosala' })
    );
    expect(settings).toMatchObject(SETTINGS);
  });

  test('a coffee no longer on the device is not archived from whatever now holds its old slot', async () => {
    const client = await loggedInClient();
    const device = fakeDevice([DEVICE_PROFILE]);
    const settings = await withFetch(device.fetch, () =>
      snapshotProfile(client, { deviceId: 'dev1', title: 'Alinea - Colombia' })
    );
    expect(settings).toBeUndefined();
  });

  test('profiles the device reported anomalies for are not archived', () => {
    expect(
      settingsFromDeviceProfile({ ...DEVICE_PROFILE, folder: 'Custom', anomalies: ['ratio=400 is outside'] })
    ).toBeUndefined();
    expect(settingsFromDeviceProfile({ ...DEVICE_PROFILE, folder: 'Unknown' })).toBeUndefined();
  });

  test("Fellow's null batch interval becomes the create default", () => {
    expect(
      settingsFromDeviceProfile({ ...DEVICE_PROFILE, folder: 'Custom', batchPulsesInterval: null })?.batchPulsesInterval
    ).toBe(30);
  });

  test('old entries without settings still load and validate', async () => {
    freshDataDir();
    const entry = await logBrew({
      coffee: coffee('Legacy'),
      profile: { title: 'Legacy', ratio: 16, bloomTemp: 95, bloomDuration: 45 }
    });
    expect(entry.profile.settings).toBeUndefined();
  });

  test('archived settings are validated like a profile write', async () => {
    freshDataDir();
    await expect(
      logBrew({
        coffee: coffee('Bad'),
        profile: {
          title: 'Bad',
          ratio: 17,
          bloomTemp: 98,
          bloomDuration: 45,
          settings: { ...SETTINGS, bloomTemperature: 140 }
        }
      })
    ).rejects.toThrow();
  });
});

describe('restoring from history', () => {
  async function logArsosala(rating?: 1 | 2 | 3 | 4 | 5, overrides: Partial<typeof SETTINGS> = {}) {
    const settings = { ...SETTINGS, ...overrides };
    const entry = await logBrew({
      coffee: coffee('Elevator - Arsosala'),
      profile: { id: 'p9', title: settings.title, ratio: 17, bloomTemp: 98, bloomDuration: 45, settings }
    });
    if (rating) await addFeedback(entry.id, { rating });
    return entry;
  }

  test('a query picks the best-rated archived brew', async () => {
    freshDataDir();
    await logArsosala(3, { bloomDuration: 30 });
    const best = await logArsosala(5, { bloomDuration: 60 });
    await logArsosala(undefined, { bloomDuration: 20 });
    expect((await findRestorableBrew({ query: 'arsosala' }))?.id).toBe(best.id);
  });

  test('recreates a deleted profile with every archived setting', async () => {
    const client = await loggedInClient();
    const entry = await logArsosala(4);
    const device = fakeDevice([]);
    const result = await withFetch(device.fetch, () => restoreProfile(client, { deviceId: 'dev1', query: 'Arsosala' }));

    expect(result).toMatchObject({ alreadyOnDevice: false, title: 'Elevator - Arsosala' });
    expect(result?.brew.id).toBe(entry.id);
    expect(device.posted).toEqual([{ profileType: 0, ...SETTINGS }]);
  });

  test('does not duplicate a profile already on the device', async () => {
    const client = await loggedInClient();
    await logArsosala(4);
    const device = fakeDevice([DEVICE_PROFILE]);
    const result = await withFetch(device.fetch, () => restoreProfile(client, { deviceId: 'dev1', query: 'Arsosala' }));

    expect(result).toMatchObject({ alreadyOnDevice: true, title: 'Elevator - Arsosala' });
    expect(device.posted).toEqual([]);
  });

  test('a title override is held to the device title rules', async () => {
    const client = await loggedInClient();
    const entry = await logArsosala(4);
    const device = fakeDevice([]);
    await expect(
      withFetch(device.fetch, () => restoreProfile(client, { deviceId: 'dev1', brewId: entry.id, title: 'Bad\ntitle' }))
    ).rejects.toThrow();
    expect(device.posted).toEqual([]);
  });

  test('a brew logged without settings cannot be restored', async () => {
    freshDataDir();
    const legacy = await logBrew({
      coffee: coffee('Legacy'),
      profile: { title: 'Legacy', ratio: 16, bloomTemp: 95, bloomDuration: 45 }
    });
    await expect(findRestorableBrew({ brewId: legacy.id })).rejects.toThrow(/before full profile settings/);
    expect(await findRestorableBrew({ query: 'Legacy' })).toBeNull();
  });
});

describe('archived settings as evidence', () => {
  test('tasted history carries every writable parameter', async () => {
    freshDataDir();
    const entry = await logBrew({
      coffee: coffee('Elevator - Arsosala'),
      profile: { title: SETTINGS.title, ratio: 17, bloomTemp: 98, bloomDuration: 45, settings: SETTINGS }
    });
    const rated = await addFeedback(entry.id, { rating: 5 });
    if (!rated) throw new Error('feedback not saved');
    const { title: _title, ...parameters } = SETTINGS;
    expect(evidenceFromBrewHistory(rated).sourceParameters).toEqual(parameters);
  });
});
