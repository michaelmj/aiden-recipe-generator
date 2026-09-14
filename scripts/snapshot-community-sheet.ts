/**
 * One-time snapshot of the public community recipe sheet (aiden-recipe-generator-8z3.2).
 *
 * The live sheet is world-writable, so the server no longer reads it by default. This script is the
 * deliberate path back in: it fetches the sheet once and writes every column out as a *candidate*
 * record. Nothing it writes reaches the server — a human reads the candidates, fixes what needs
 * fixing, and copies the ones worth shipping into data/recipes.json as a reviewed commit.
 *
 * Each candidate carries two views of the same column: the fields that survived the sanitizer the
 * live path uses, and the raw cells underneath them. They disagree often and on purpose — the sheet
 * writes ratios as "1:16" and temperatures in Fahrenheit, which the range checks drop or, worse,
 * salvage a misleading fragment of. Resolving that disagreement by hand is the review step.
 *
 *   bun scripts/snapshot-community-sheet.ts [--out <path>] [--url <csv url>]
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { REQUEST_TIMEOUT_MS, SHEET_MAX_BYTES } from '@/config';
import { sanitizeProfile } from '@/sheet/sanitize';
import { parseProfileCells } from '@/sheet/store';

/** The sheet this project has always drawn on, pinned here so a refresh reads the same document. */
const SHEET_ID = '1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
const DEFAULT_CSV_URL = `${SHEET_URL}/export?format=csv`;
const CREDIT = 'Fellow Aiden community recipe sheet';

const DEFAULT_OUT = new URL('../data/community-snapshot.json', import.meta.url).pathname;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/** Ids are slugs, and two columns can share a title, so collisions get a suffix. */
function slugId(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'recipe';

  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/csv,*/*' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status} ${res.statusText}`);

  const csv = await res.text();
  // Same byte cap as the live path: a snapshot is not a reason to accept a bigger document.
  if (Buffer.byteLength(csv) > SHEET_MAX_BYTES) throw new Error(`Sheet CSV is larger than ${SHEET_MAX_BYTES} bytes.`);
  return csv;
}

const url = arg('url', DEFAULT_CSV_URL);
const out = arg('out', DEFAULT_OUT);

const csv = await fetchCsv(url);
const sha256 = createHash('sha256').update(csv).digest('hex');

const taken = new Set<string>();
const candidates = parseProfileCells(csv)
  .map((raw) => ({ raw, profile: sanitizeProfile(raw) }))
  // A column whose title does not survive sanitizing has nothing to review.
  .filter((c): c is { raw: Record<string, string>; profile: NonNullable<typeof c.profile> } => c.profile !== null)
  .map(({ raw, profile }) => ({
    id: slugId(profile.title, taken),
    source: { kind: 'community-sheet' as const, credit: CREDIT, url: SHEET_URL },
    ...profile,
    // Not part of the dataset format: the loader rejects unknown keys, so a candidate pasted in
    // without being reviewed is dropped rather than shipped.
    review: { raw }
  }));

await writeFile(
  out,
  `${JSON.stringify({ snapshot: { url, takenAt: new Date().toISOString().slice(0, 10), sha256, credit: CREDIT }, candidates }, null, 2)}\n`
);

console.log(`Wrote ${candidates.length} candidate record(s) to ${out}`);
console.log(`Snapshot sha256: ${sha256}`);
console.log(
  'Review each candidate against its `review.raw` cells, drop that key, then copy keepers into data/recipes.json.'
);
