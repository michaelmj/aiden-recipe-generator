/** Validated, bounded, atomic persisted user preferences. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { getAppDataDir } from '@/config';
import { AidenRatioSchema, ResourceIdSchema } from '@/schemas';
import { atomicWriteStore, readStore, withStoreLock } from '@/storage/jsonStore';
import { sanitizeText } from '@/text';

const SETTINGS_FILE = 'user-settings.json';
const MAX_SETTINGS_BYTES = 64 * 1024;

function safeText(max = 200) {
  return z
    .string()
    .max(4_000)
    .transform((value) => sanitizeText(value, max))
    .pipe(z.string().min(1).max(max));
}

export const UserSettingsSchema = z.strictObject({
  grinder: safeText().optional(),
  defaultDeviceId: ResourceIdSchema.optional(),
  preferredRatio: AidenRatioSchema.optional(),
  elevation: z.number().finite().min(-500).max(9_000).optional(),
  notes: safeText(1_000).optional()
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;
export const UserSettingsPatchSchema = UserSettingsSchema.partial();

async function getPath(): Promise<string> {
  const dir = getAppDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, SETTINGS_FILE);
}

export async function getSettings(): Promise<UserSettings> {
  const path = await getPath();
  return withStoreLock(path, () => readStore(path, UserSettingsSchema, () => ({}), MAX_SETTINGS_BYTES));
}

export async function updateSettings(input: z.input<typeof UserSettingsPatchSchema>): Promise<UserSettings> {
  const patch = UserSettingsPatchSchema.parse(input);
  const path = await getPath();
  return withStoreLock(path, async () => {
    const current = await readStore(path, UserSettingsSchema, () => ({}), MAX_SETTINGS_BYTES);
    const updated = UserSettingsSchema.parse({ ...current, ...patch });
    await atomicWriteStore(path, updated);
    return updated;
  });
}
