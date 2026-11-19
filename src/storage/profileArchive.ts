/**
 * Keep brewed profiles recoverable after they leave the brewer (aiden-recipe-generator-3ha).
 *
 * The operator keeps only current coffees on the Aiden and deletes the rest. The brew log is
 * therefore the archive: each entry carries the full settings it was brewed with, and a profile
 * can be written back from it when the coffee returns.
 */

import type { FellowClient, Profile } from '@/fellow/client';
import { type AidenCreateProfileInput, AidenCreateProfileSchema } from '@/schemas';
import { type BrewEntry, findRestorableBrew } from '@/storage/brewLog';

/**
 * Turn a profile read from the device into writable settings, or undefined when the device
 * reported something this client would not write back: anomalies, an unknown folder, or values
 * that fail the canonical create schema.
 */
export function settingsFromDeviceProfile(profile: Profile): AidenCreateProfileInput | undefined {
  if (profile.anomalies?.length || profile.folder === 'Unknown') return undefined;
  const parsed = AidenCreateProfileSchema.safeParse({
    title: profile.title,
    ratio: profile.ratio,
    bloomEnabled: profile.bloomEnabled,
    bloomRatio: profile.bloomRatio,
    bloomDuration: profile.bloomDuration,
    bloomTemperature: profile.bloomTemperature,
    ssPulsesEnabled: profile.ssPulsesEnabled,
    ssPulsesNumber: profile.ssPulsesNumber,
    ssPulsesInterval: profile.ssPulsesInterval,
    ssPulseTemperatures: profile.ssPulseTemperatures,
    batchPulsesEnabled: profile.batchPulsesEnabled,
    batchPulsesNumber: profile.batchPulsesNumber,
    // Fellow's own defaults report a null interval; the create schema's default is the same 30s.
    ...(profile.batchPulsesInterval === null ? {} : { batchPulsesInterval: profile.batchPulsesInterval }),
    batchPulseTemperatures: profile.batchPulseTemperatures
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read a profile's full settings from the device by its title. Ids are not consulted: Fellow
 * reuses them, so an id can point at a different coffee than the one being logged.
 */
export async function snapshotProfile(
  fellow: FellowClient,
  args: { deviceId: string; title: string }
): Promise<AidenCreateProfileInput | undefined> {
  const profile = await fellow.findProfileByTitle(args);
  return profile ? settingsFromDeviceProfile(profile) : undefined;
}

export type RestoreResult = {
  brew: BrewEntry;
  title: string;
  alreadyOnDevice: boolean;
};

/**
 * Write a logged brew's settings back to the device. A Custom profile already on the device with
 * the same title is reused instead of duplicated; two of them is an error, as either could be meant.
 */
export async function restoreProfile(
  fellow: FellowClient,
  args: { deviceId: string; brewId?: string; query?: string; title?: string }
): Promise<RestoreResult | null> {
  const brew = await findRestorableBrew({ brewId: args.brewId, query: args.query });
  if (!brew?.profile.settings) return null;

  const settings = AidenCreateProfileSchema.parse({
    ...brew.profile.settings,
    ...(args.title ? { title: args.title } : {})
  });

  const existing = await fellow.findProfileByTitle({ deviceId: args.deviceId, title: settings.title });
  if (existing?.folder === 'Custom') return { brew, title: settings.title, alreadyOnDevice: true };

  await fellow.createProfile({ deviceId: args.deviceId, profile: settings });
  return { brew, title: settings.title, alreadyOnDevice: false };
}
