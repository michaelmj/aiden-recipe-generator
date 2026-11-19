/** Validated, bounded, atomic local brew history. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { getAppDataDir } from '@/config';
import {
  AidenBloomDurationSchema,
  AidenCreateProfileSchema,
  AidenRatioSchema,
  AidenTemperatureSchema,
  type BrewRecipe,
  RecipeSchema,
  ResourceIdSchema,
  recipeOf
} from '@/schemas';
import { atomicWriteStore, readStore, withStoreLock } from '@/storage/jsonStore';
import { sanitizeText } from '@/text';

const LOG_FILE = 'brew-log.json';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function safeText(max = 200) {
  return z
    .string()
    .max(4_000)
    .transform((value) => sanitizeText(value, max))
    .pipe(z.string().min(1).max(max));
}

const BrewIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const FeedbackSchema = z.strictObject({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  taste: safeText().optional(),
  notes: safeText(1_000).optional()
});

const CoffeeSchema = z.strictObject({
  name: safeText(),
  roaster: safeText().optional(),
  origin: safeText().optional(),
  roast: safeText().optional(),
  processing: safeText().optional()
});

/**
 * What an entry logged before full recipes were recorded still knows: ratio and bloom only, with
 * no bloom ratio and no pulse steps (aiden-recipe-generator-46y.2).
 */
const PartialRecipeSchema = z.strictObject({
  ratio: AidenRatioSchema,
  bloomTemperature: AidenTemperatureSchema,
  bloomDuration: AidenBloomDurationSchema
});

/**
 * The profile a brew used, named by its title. `recipe` is the whole brew — bloom and every
 * single-serve and batch pulse step — so the profile can be recreated after it leaves the brewer.
 * Entries logged before that carry `partial: true` and only the ratio and bloom they recorded.
 */
const BrewProfileSchema = z.union([
  z.strictObject({ title: safeText(120), recipe: RecipeSchema }),
  z.strictObject({ title: safeText(120), partial: z.literal(true), recipe: PartialRecipeSchema })
]);

/**
 * The on-disk shape before aiden-recipe-generator-46y.2: a ratio/bloom summary, an optional
 * archived settings snapshot, and the device's slot id (which Fellow reuses, so it is dropped).
 */
const LegacyBrewProfileSchema = z
  .strictObject({
    id: ResourceIdSchema.optional(),
    title: safeText(120),
    ratio: AidenRatioSchema,
    bloomTemp: AidenTemperatureSchema,
    bloomDuration: AidenBloomDurationSchema,
    settings: AidenCreateProfileSchema.optional()
  })
  .transform(
    (legacy): z.output<typeof BrewProfileSchema> =>
      legacy.settings
        ? { title: legacy.title, recipe: recipeOf(legacy.settings) }
        : {
            title: legacy.title,
            partial: true,
            recipe: { ratio: legacy.ratio, bloomTemperature: legacy.bloomTemp, bloomDuration: legacy.bloomDuration }
          }
  );

export const BrewEntrySchema = z.strictObject({
  id: BrewIdSchema,
  timestamp: z.number().int().nonnegative(),
  coffee: CoffeeSchema,
  profile: BrewProfileSchema,
  feedback: FeedbackSchema.optional()
});
export type BrewEntry = z.infer<typeof BrewEntrySchema>;
export type FullBrewEntry = BrewEntry & { profile: { recipe: BrewRecipe; partial?: undefined } };

/** True when the entry records the whole recipe, not a pre-46y.2 summary. */
export function hasFullRecipe(entry: BrewEntry): entry is FullBrewEntry {
  return !('partial' in entry.profile);
}

/** Entries as stored: the current shape, or a legacy one migrated on read. */
const StoredBrewEntrySchema = BrewEntrySchema.extend({
  profile: z.union([BrewProfileSchema, LegacyBrewProfileSchema])
});

const NewBrewSchema = z.strictObject({
  coffee: CoffeeSchema,
  profile: z.strictObject({ title: safeText(120), recipe: RecipeSchema })
});
const BrewLogSchema = z.strictObject({ entries: z.array(StoredBrewEntrySchema).max(MAX_ENTRIES) });
type BrewLog = z.infer<typeof BrewLogSchema>;

async function getLogPath(): Promise<string> {
  const dir = getAppDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, LOG_FILE);
}

async function readLog(path: string): Promise<BrewLog> {
  return readStore(path, BrewLogSchema, () => ({ entries: [] }), MAX_LOG_BYTES);
}

export async function logBrew(input: z.input<typeof NewBrewSchema>): Promise<BrewEntry> {
  const entry = NewBrewSchema.parse(input);
  const path = await getLogPath();
  return withStoreLock(path, async () => {
    const log = await readLog(path);
    if (log.entries.length >= MAX_ENTRIES)
      throw new Error(`The brew log holds ${MAX_ENTRIES} entries; remove some older ones before logging another.`);
    const created = BrewEntrySchema.parse({
      ...entry,
      id: `brew-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      timestamp: Date.now()
    });
    log.entries.push(created);
    await atomicWriteStore(path, log);
    return created;
  });
}

export async function addFeedback(brewId: string, input: z.input<typeof FeedbackSchema>): Promise<BrewEntry | null> {
  const id = BrewIdSchema.parse(brewId);
  const feedback = FeedbackSchema.parse(input);
  const path = await getLogPath();
  return withStoreLock(path, async () => {
    const log = await readLog(path);
    const entry = log.entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    entry.feedback = feedback;
    await atomicWriteStore(path, log);
    return entry;
  });
}

/**
 * Give an entry its whole recipe, keeping its coffee, time and feedback. For entries logged before
 * full recipes were recorded, once the recipe brewed is known again.
 */
export async function completeRecipe(brewId: string, recipe: z.input<typeof RecipeSchema>): Promise<BrewEntry | null> {
  const id = BrewIdSchema.parse(brewId);
  const full = RecipeSchema.parse(recipe);
  const path = await getLogPath();
  return withStoreLock(path, async () => {
    const log = await readLog(path);
    const entry = log.entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    entry.profile = { title: entry.profile.title, recipe: full };
    await atomicWriteStore(path, log);
    return entry;
  });
}

export async function getBrew(brewId: string): Promise<BrewEntry | null> {
  const id = BrewIdSchema.parse(brewId);
  const path = await getLogPath();
  return withStoreLock(path, async () => (await readLog(path)).entries.find((entry) => entry.id === id) ?? null);
}

export async function getRecentBrews(limit = 20): Promise<BrewEntry[]> {
  const bounded = z.number().int().min(1).max(100).parse(limit);
  const path = await getLogPath();
  return withStoreLock(path, async () => (await readLog(path)).entries.slice(-bounded).reverse());
}

export async function searchBrews(query: string): Promise<BrewEntry[]> {
  const q = safeText().parse(query).toLowerCase();
  const path = await getLogPath();
  return withStoreLock(path, async () =>
    (await readLog(path)).entries.filter((entry) =>
      [
        entry.coffee.name,
        entry.coffee.roaster,
        entry.coffee.origin,
        entry.coffee.roast,
        entry.coffee.processing,
        entry.profile.title
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  );
}

const SimilarCoffeeSchema = z.strictObject({
  origin: safeText().optional(),
  roast: safeText().optional(),
  processing: safeText().optional()
});

export async function getSimilarBrews(input: z.input<typeof SimilarCoffeeSchema>): Promise<BrewEntry[]> {
  const coffee = SimilarCoffeeSchema.parse(input);
  const path = await getLogPath();
  return withStoreLock(path, async () =>
    (await readLog(path)).entries.filter((entry) => {
      if (coffee.origin && entry.coffee.origin?.toLowerCase().includes(coffee.origin.toLowerCase())) return true;
      if (coffee.roast && entry.coffee.roast?.toLowerCase().includes(coffee.roast.toLowerCase())) return true;
      if (coffee.processing && entry.coffee.processing?.toLowerCase().includes(coffee.processing.toLowerCase()))
        return true;
      return false;
    })
  );
}

const RestoreQuerySchema = z
  .strictObject({ brewId: BrewIdSchema.optional(), query: safeText().optional() })
  .refine((value) => value.brewId || value.query, 'Name a brewId or a search query.');

/**
 * The logged brew to rebuild a profile from: the named entry, or else the best-rated entry
 * matching the query (rated before unrated, then newest). Only entries with the full recipe
 * qualify, because a profile cannot be rebuilt from ratio and bloom alone.
 */
export async function findRestorableBrew(input: z.input<typeof RestoreQuerySchema>): Promise<FullBrewEntry | null> {
  const { brewId, query } = RestoreQuerySchema.parse(input);
  const path = await getLogPath();
  const entries = await withStoreLock(path, async () => (await readLog(path)).entries);
  if (brewId) {
    const entry = entries.find((candidate) => candidate.id === brewId);
    if (!entry) return null;
    if (!hasFullRecipe(entry))
      throw new Error(
        `Brew ${brewId} was logged before full recipes were recorded, so it cannot be restored. ` +
          'Complete it with storage.completeRecipe first.'
      );
    return entry;
  }
  const q = (query ?? '').toLowerCase();
  const matches = entries
    .filter(hasFullRecipe)
    .filter((entry) =>
      [entry.coffee.name, entry.coffee.roaster, entry.coffee.origin, entry.profile.title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  matches.sort((a, b) => (b.feedback?.rating ?? 0) - (a.feedback?.rating ?? 0) || b.timestamp - a.timestamp);
  return matches[0] ?? null;
}
