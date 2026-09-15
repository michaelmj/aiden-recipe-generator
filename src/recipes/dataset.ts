/**
 * The bundled recipe dataset — the recipe source that replaces the world-writable community sheet
 * as the default (aiden-recipe-generator-8z3).
 *
 * Two things make this different from the sheet path: the file ships with the server, so reading it
 * involves no network call and no third party, and every record says where it came from. It is still
 * validated and sanitized on load with the same rules the sheet cells go through — a bad edit to our
 * own file, or a snapshot taken from the community sheet, must not be trusted just because it is on
 * disk.
 */

import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import { type SanitizedSheetProfile, sanitizeProfile } from '@/sheet/sanitize';
import { sanitizeText, TEXT_MAX_CHARS } from '@/text';

/** Where a record came from, which is what its trust level rests on. */
export type RecipeSource = {
  /**
   * first-party: brewed and rated by the operator, no stranger involved.
   * community-sheet: taken from a credited public sheet in a reviewed snapshot, not fetched live.
   * roaster: a recommendation published by the roaster for a specific coffee.
   */
  kind: 'first-party' | 'community-sheet' | 'roaster';
  /** Who to credit, for anything not first-party. */
  credit?: string;
  url?: string;
};

/** One recipe: the same brewing fields the sheet path produces, plus an id and its provenance. */
export type Recipe = SanitizedSheetProfile & {
  id: string;
  source: RecipeSource;
  /** Free text from whoever recorded the recipe — tasting result, grinder setting, caveats. */
  notes?: string;
};

/** Default location of the bundled file, resolved next to the repo root in both src and dist. */
export const BUNDLED_DATASET_PATH = new URL('../../data/recipes.json', import.meta.url).pathname;

/** Ids are referenced in tool output and logs, so they stay to a slug. */
const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Recipe ids are lowercase slugs: letters, digits, and hyphens.');

const SourceSchema = z.strictObject({
  kind: z.enum(['first-party', 'community-sheet', 'roaster']),
  credit: z.string().max(200).optional(),
  url: z.string().max(500).optional()
});

/**
 * Structure of one record as written in the file. Brewing values are strings here for the same
 * reason they are strings on the sheet path: they go through the same range checks, which parse
 * them, and keeping one representation means one set of rules.
 */
const RecordSchema = z.strictObject({
  id: IdSchema,
  source: SourceSchema,
  notes: z.string().max(2_000).optional(),
  title: z.string().min(1),
  origin: z.string().optional(),
  roast: z.string().optional(),
  processing: z.string().optional(),
  varietal: z.string().optional(),
  brewRatio: z.string().optional(),
  bloomRatio: z.string().optional(),
  bloomTime: z.string().optional(),
  bloomTemp: z.string().optional(),
  ssPulsesNumber: z.string().optional(),
  ssPulsesInterval: z.string().optional(),
  ssPulseTemps: z.string().optional(),
  batchPulsesNumber: z.string().optional(),
  batchPulsesInterval: z.string().optional(),
  batchPulseTemps: z.string().optional()
});

/**
 * A snapshot the dataset was seeded from: which document, when it was taken, and the digest of the
 * bytes that were read. It is the credit for anything not first-party, and it is what makes a
 * refresh checkable — re-fetch, re-hash, and the diff is what a human has to review.
 */
const SnapshotSchema = z.strictObject({
  source: z.enum(['community-sheet', 'roaster']),
  credit: z.string().min(1).max(200),
  url: z.string().max(500).optional(),
  takenAt: z.string().max(40),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Snapshot digests are lowercase hex sha256.')
    .optional()
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

/** The file itself. `version` exists so a format change can be detected rather than guessed at. */
const FileSchema = z.strictObject({
  version: z.literal(1),
  snapshots: z.array(SnapshotSchema).optional(),
  recipes: z.array(z.unknown())
});

export type SearchQuery = {
  query?: string;
  origin?: string;
  roast?: string;
  processing?: string;
  limit?: number;
};

/** What a load did, so a dropped record is visible instead of silently missing. */
export type LoadReport = { kept: number; dropped: number };

/** Turn one raw record into a Recipe, or null if it does not survive validation and sanitizing. */
function toRecipe(raw: unknown): Recipe | null {
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) return null;

  const { id, source, notes, ...brewing } = parsed.data;
  // Same sanitizer as the sheet cells: length caps, escapes and invisible characters stripped,
  // brewing values range-checked. A record whose title does not survive is dropped whole.
  const profile = sanitizeProfile(brewing as Record<string, string>);
  if (!profile || profile.validation.status === 'invalid') return null;

  const recipe: Recipe = {
    ...profile,
    id,
    source: {
      kind: source.kind,
      ...(source.credit ? { credit: sanitizeText(source.credit) } : {}),
      ...(source.url ? { url: sanitizeText(source.url, 500) } : {})
    }
  };
  if (notes) {
    const clean = sanitizeText(notes, TEXT_MAX_CHARS * 4);
    if (clean) recipe.notes = clean;
  }
  return recipe;
}

/**
 * Reads and serves the bundled dataset.
 * Load is lazy and cached: the file does not change while the server runs, and nothing here can
 * fail in a way that should take the server down — a missing or malformed file leaves an empty
 * dataset and a logged reason.
 */
export class RecipeDataset {
  private path: string;
  private recipes: Recipe[] | null = null;
  private snapshotsRead: Snapshot[] = [];
  private report: LoadReport = { kept: 0, dropped: 0 };

  constructor(opts?: { path?: string }) {
    this.path = opts?.path ?? BUNDLED_DATASET_PATH;
  }

  /** Load the file if it has not been read yet, and report what survived. */
  async load(): Promise<LoadReport> {
    if (this.recipes) return this.report;

    let file: unknown;
    try {
      file = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err) {
      // No network is involved, so the only failures are a missing file or bad JSON. Both mean no
      // recipes rather than a dead server; the sheet path and web search remain.
      console.error('Failed to read the bundled recipe dataset:', err instanceof Error ? err.message : err);
      this.recipes = [];
      return this.report;
    }

    const parsed = FileSchema.safeParse(file);
    if (!parsed.success) {
      console.error(`Bundled recipe dataset at ${this.path} is not a version 1 dataset; ignoring it.`);
      this.recipes = [];
      return this.report;
    }

    const kept: Recipe[] = [];
    const seen = new Set<string>();
    let dropped = 0;

    for (const raw of parsed.data.recipes) {
      const recipe = toRecipe(raw);
      // A duplicate id would make tool output ambiguous about which record was meant.
      if (!recipe || seen.has(recipe.id)) {
        dropped += 1;
        continue;
      }
      seen.add(recipe.id);
      kept.push(recipe);
    }

    if (dropped > 0) console.error(`Bundled recipe dataset: dropped ${dropped} record(s) that failed validation.`);

    this.recipes = kept;
    this.snapshotsRead = parsed.data.snapshots ?? [];
    this.report = { kept: kept.length, dropped };
    return this.report;
  }

  /** Where the non-first-party records came from, for credit and for checking a refresh. */
  async snapshots(): Promise<Snapshot[]> {
    await this.load();
    return this.snapshotsRead;
  }

  /** Every recipe that survived loading. */
  async list(): Promise<Recipe[]> {
    await this.load();
    return this.recipes ?? [];
  }

  /** Filter by origin, roast, processing, or free text across the descriptive fields. */
  async search(q: SearchQuery = {}): Promise<Recipe[]> {
    const all = await this.list();
    const contains = (value: string | undefined, needle: string) =>
      (value ?? '').toLowerCase().includes(needle.toLowerCase());

    const matches = all.filter((r) => {
      if (q.query) {
        const searchable = [r.title, r.origin, r.roast, r.processing, r.varietal, r.notes, r.source.credit]
          .filter(Boolean)
          .join(' ');
        if (!contains(searchable, q.query)) return false;
      }
      if (q.origin && !contains(r.origin, q.origin)) return false;
      if (q.roast && !contains(r.roast, q.roast)) return false;
      if (q.processing && !contains(r.processing, q.processing)) return false;
      return true;
    });

    return q.limit === undefined ? matches : matches.slice(0, q.limit);
  }

  /** One recipe by id, or undefined. */
  async get(id: string): Promise<Recipe | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }
}
