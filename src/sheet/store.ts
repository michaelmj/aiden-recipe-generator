/**
 * Community Sheet Store - fetches and caches Aiden recipes from a public Google Sheet.
 * The sheet contains user-submitted brew profiles with coffee details.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { DEFAULT_SHEET_CSV_URL, getAppDataDir, SHEET_MAX_REDIRECTS } from '@/config';
import { sanitizeProfile } from '@/sheet/sanitize';
import { assertAllowedSheetUrl } from '@/sheet/url';

/** A profile from the community Google Sheet */
export type SheetProfile = {
  title: string;
  origin?: string;
  roast?: string;
  processing?: string;
  varietal?: string;
  brewRatio?: string;
  bloomRatio?: string;
  bloomTime?: string;
  bloomTemp?: string;
  ssPulsesNumber?: string;
  ssPulsesInterval?: string;
  ssPulseTemps?: string;
  batchPulsesNumber?: string;
  batchPulsesInterval?: string;
  batchPulseTemps?: string;
};

type Cache = { cachedAtMs: number; csvUrl: string; profiles: SheetProfile[] };

/** Maps sheet column labels to SheetProfile fields */
const FIELD_MAP: Record<string, keyof SheetProfile> = {
  Origin: 'origin',
  Roast: 'roast',
  Processing: 'processing',
  Varietal: 'varietal',
  'Brew Ratio': 'brewRatio',
  'Bloom Ratio': 'bloomRatio',
  'Bloom Time': 'bloomTime',
  'Bloom Temp': 'bloomTemp',
  'Single No. of Pulses on': 'ssPulsesNumber',
  'Single Time btwn Pulses': 'ssPulsesInterval',
  'Single Pulse Temps': 'ssPulseTemps',
  'Batch No. of Pulses': 'batchPulsesNumber',
  'Batch Time btwn Pulses': 'batchPulsesInterval',
  'Batch Pulse Temps': 'batchPulseTemps'
};

/** Parse CSV into SheetProfile array (sheet is column-oriented, not row-oriented) */
function parseProfiles(csv: string): SheetProfile[] {
  const rows = parse(csv, { relax_quotes: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  if (rows.length < 3) throw new Error('Sheet CSV looks empty/unexpected.');

  const labels = rows.map((r) => r[0]?.trim() ?? '');
  const colCount = Math.max(...rows.map((r) => r.length));

  return Array.from({ length: colCount - 1 }, (_, i) => {
    const col = i + 1;
    const raw: Record<string, string> = {};

    const title = rows[0]?.[col]?.trim();
    if (title) raw.title = title;
    labels.forEach((label, rowIdx) => {
      const field = FIELD_MAP[label];
      if (field) {
        const value = rows[rowIdx]?.[col]?.trim();
        if (value) raw[field] = value;
      }
    });

    // Every cell is stranger-written, so the column only becomes a profile if it survives
    // sanitizing and range checks; a column that fails is dropped rather than partly trusted.
    return sanitizeProfile(raw);
  }).filter((p): p is SheetProfile => p !== null);
}

/**
 * Fetch the sheet, re-checking the allowlist on every redirect hop.
 * Redirects are handled manually: the platform would otherwise follow a 302 to any host, which
 * would defeat the check on the initial URL.
 */
async function fetchAllowedSheet(startUrl: string): Promise<{ res: Response; url: string }> {
  let target = assertAllowedSheetUrl(startUrl).toString();

  for (let hop = 0; hop <= SHEET_MAX_REDIRECTS; hop++) {
    const res = await fetch(target, {
      headers: { Accept: 'text/csv,*/*' },
      redirect: 'manual'
    });

    const isRedirect = res.status >= 300 && res.status < 400;
    if (!isRedirect) return { res, url: target };

    const location = res.headers.get('location');
    if (!location) throw new Error(`Sheet host returned ${res.status} with no Location header.`);

    // Relative redirects resolve against the current target, then face the same host check.
    target = assertAllowedSheetUrl(new URL(location, target).toString()).toString();
  }

  throw new Error(`Sheet URL exceeded ${SHEET_MAX_REDIRECTS} redirects.`);
}

/**
 * Manages fetching and caching community profiles from Google Sheets.
 * Cache TTL defaults to 6 hours.
 */
export class SheetProfileStore {
  private csvUrl: string;
  private cacheTtlMs: number;
  private cachePath = join(getAppDataDir(), 'sheetProfiles.json');

  constructor(opts?: { csvUrl?: string; cacheTtlMs?: number }) {
    this.csvUrl = opts?.csvUrl ?? process.env.AIDEN_AI_SHEET_CSV_URL ?? DEFAULT_SHEET_CSV_URL;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 6 * 60 * 60 * 1000;
  }

  /** Ensure cache is fresh, fetch if stale */
  async ensureCached(): Promise<void> {
    const cache = await this.readCache();
    if (!cache || Date.now() - cache.cachedAtMs > this.cacheTtlMs) {
      await this.sync({ csvUrl: this.csvUrl });
    }
  }

  /** Fetch fresh data from the sheet and update cache */
  async sync({ csvUrl }: { csvUrl?: string }) {
    const { res, url } = await fetchAllowedSheet(csvUrl ?? this.csvUrl);

    if (!res.ok) {
      throw new Error(`Failed to fetch sheet CSV (${res.status}).`);
    }

    const profiles = parseProfiles(await res.text());
    const cache: Cache = { cachedAtMs: Date.now(), csvUrl: url, profiles };

    await mkdir(getAppDataDir(), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf8');

    return { ok: true, csvUrl: url, profileCount: profiles.length };
  }

  /** Get cached profiles */
  async getProfiles(): Promise<SheetProfile[]> {
    return (await this.readCache())?.profiles ?? [];
  }

  private async readCache(): Promise<Cache | null> {
    try {
      return JSON.parse(await readFile(this.cachePath, 'utf8')) as Cache;
    } catch {
      return null;
    }
  }
}
