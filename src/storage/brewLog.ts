/** Validated, bounded, atomic local brew history. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { getAppDataDir } from '@/config';
import { AidenBloomDurationSchema, AidenRatioSchema, AidenTemperatureSchema, ResourceIdSchema } from '@/schemas';
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

export const BrewEntrySchema = z.strictObject({
  id: BrewIdSchema,
  timestamp: z.number().int().nonnegative(),
  coffee: z.strictObject({
    name: safeText(),
    roaster: safeText().optional(),
    origin: safeText().optional(),
    roast: safeText().optional(),
    processing: safeText().optional()
  }),
  profile: z.strictObject({
    id: ResourceIdSchema.optional(),
    title: safeText(120),
    ratio: AidenRatioSchema,
    bloomTemp: AidenTemperatureSchema,
    bloomDuration: AidenBloomDurationSchema
  }),
  feedback: FeedbackSchema.optional()
});
export type BrewEntry = z.infer<typeof BrewEntrySchema>;

const NewBrewSchema = BrewEntrySchema.omit({ id: true, timestamp: true });
const BrewLogSchema = z.strictObject({ entries: z.array(BrewEntrySchema).max(MAX_ENTRIES) });
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
    if (log.entries.length >= MAX_ENTRIES) throw new Error(`Brew log is limited to ${MAX_ENTRIES} entries.`);
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
