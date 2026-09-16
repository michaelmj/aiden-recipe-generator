/**
 * Community Sheet Store - fetches and caches Aiden recipes from a public Google Sheet.
 * The sheet contains user-submitted brew profiles with coffee details.
 *
 * This is the opt-in source, not the default one (aiden-recipe-generator-8z3.4): it does nothing
 * at all unless an operator sets AIDEN_AI_SHEET_CSV_URL. When they do, the fetch stays bounded and
 * host-checked and the profiles stay labelled untrusted all the way out to the agent.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import {
  getAppDataDir,
  getSheetCsvUrl,
  REQUEST_TIMEOUT_MS,
  SHEET_ALLOWED_CONTENT_TYPES,
  SHEET_MAX_BYTES,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_RECORD_CHARS,
  SHEET_MAX_REDIRECTS,
  SHEET_MAX_ROWS
} from '@/config';
import { type SanitizedSheetProfile, sanitizeProfile } from '@/sheet/sanitize';
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

type Cache = { cachedAtMs: number; csvUrl: string; profiles: SanitizedSheetProfile[] };

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

/**
 * Split the CSV into one raw cell record per recipe column, before any sanitizing.
 * Exported for the snapshot script (scripts/snapshot-community-sheet.ts), which shows the reviewer
 * what a cell said next to what survived sanitizing — the sheet writes ratios as "1:16" and temps
 * in Fahrenheit, so the two rarely match and the difference is the thing a human has to resolve.
 */
export function parseProfileCells(csv: string): Record<string, string>[] {
  // `to` stops the row allocation one past the cap: the extra row is what tells us the sheet was
  // over the limit rather than merely close to it, so it can be rejected instead of truncated.
  const rows = parse(csv, {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: SHEET_MAX_RECORD_CHARS,
    to: SHEET_MAX_ROWS + 1
  }) as string[][];

  if (rows.length < 3) throw new Error('The sheet CSV had too few rows to hold a recipe; check the sheet URL.');
  if (rows.length > SHEET_MAX_ROWS) {
    throw new Error(`Sheet CSV has more than ${SHEET_MAX_ROWS} rows.`);
  }

  const labels = rows.map((r) => r[0]?.trim() ?? '');
  // Column 0 holds the labels, so the widest row sets how many recipes the sheet claims.
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount - 1 > SHEET_MAX_COLUMNS) {
    throw new Error(`Sheet CSV has more than ${SHEET_MAX_COLUMNS} recipe columns.`);
  }

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

    return raw;
  });
}

/** Parse CSV into SheetProfile array (sheet is column-oriented, not row-oriented) */
function parseProfiles(csv: string): SanitizedSheetProfile[] {
  // Every cell is stranger-written. Invalid fields are removed, but their validation issues stay
  // on the returned profile so a partial source can never look like reviewed complete guidance.
  return parseProfileCells(csv)
    .map((raw) => sanitizeProfile(raw))
    .filter((p): p is SanitizedSheetProfile => p !== null);
}

/**
 * Fetch the sheet, re-checking the allowlist on every redirect hop.
 * Redirects are handled manually: the platform would otherwise follow a 302 to any host, which
 * would defeat the check on the initial URL.
 */
async function fetchAllowedSheet(startUrl: string, signal: AbortSignal): Promise<{ res: Response; url: string }> {
  let target = assertAllowedSheetUrl(startUrl).toString();

  for (let hop = 0; hop <= SHEET_MAX_REDIRECTS; hop++) {
    const res = await fetch(target, {
      headers: { Accept: 'text/csv,*/*' },
      redirect: 'manual',
      signal
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

/** Reject a body that is not CSV-ish, so an HTML sign-in or error page never reaches the parser. */
function assertParseableContentType(res: Response): void {
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!SHEET_ALLOWED_CONTENT_TYPES.includes(mediaType as (typeof SHEET_ALLOWED_CONTENT_TYPES)[number])) {
    throw new Error(
      `Sheet response was '${mediaType || 'unknown'}', expected one of ${SHEET_ALLOWED_CONTENT_TYPES.join(', ')}.`
    );
  }
}

/**
 * Read the body as text, aborting past `limitBytes`.
 * A declared Content-Length is only a hint, so the running total is what enforces the cap: an
 * endless or lying response stops at the limit instead of growing until the process dies.
 */
async function readCappedText(res: Response, limitBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new Error(`Sheet CSV declared ${declared} bytes, over the ${limitBytes} byte limit.`);
  }

  if (!res.body) throw new Error('Sheet response had no body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > limitBytes) throw new Error(`Sheet CSV exceeded the ${limitBytes} byte limit.`);

      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Cancel on the error path too, so an oversized body stops arriving instead of draining.
    await reader.cancel().catch(() => {});
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

/**
 * Manages fetching and caching community profiles from Google Sheets.
 * Cache TTL defaults to 6 hours.
 */
export class SheetProfileStore {
  private csvUrl: string | undefined;
  private cacheTtlMs: number;
  private timeoutMs: number;
  private cachePath = join(getAppDataDir(), 'sheetProfiles.json');
  private warmup: Promise<void> | null = null;

  constructor(opts?: { csvUrl?: string; cacheTtlMs?: number; timeoutMs?: number }) {
    this.csvUrl = opts?.csvUrl ?? getSheetCsvUrl();
    this.cacheTtlMs = opts?.cacheTtlMs ?? 6 * 60 * 60 * 1000;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Whether an operator has opted into the live sheet.
   * There is no fallback URL, so an unconfigured store is inert: it fetches nothing and serves
   * nothing, and the bundled dataset is the whole recipe source.
   */
  isConfigured(): boolean {
    return this.csvUrl !== undefined;
  }

  /**
   * Start a best-effort cache warm without making the caller wait on the network.
   * Never rejects: the sheet is a remote third party, so an unreachable or stalling host must not
   * take the server down with it. The in-flight promise is returned so a reader that has no cache
   * at all can wait for this fetch instead of starting a second one.
   */
  warmCache(): Promise<void> {
    // Nothing configured means nothing to warm; returning early is what keeps an unconfigured
    // server off the network entirely.
    if (!this.isConfigured()) return Promise.resolve();

    if (!this.warmup) {
      this.warmup = this.ensureCached()
        .catch((err) => {
          console.error(
            'Failed to load community sheet (continuing without it):',
            err instanceof Error ? err.message : err
          );
        })
        .finally(() => {
          this.warmup = null;
        });
    }
    return this.warmup;
  }

  /** Ensure cache is fresh, fetch if stale */
  async ensureCached(): Promise<void> {
    if (!this.isConfigured()) return;

    const cache = await this.readCache();
    if (!cache || Date.now() - cache.cachedAtMs > this.cacheTtlMs) {
      await this.sync({ csvUrl: this.csvUrl });
    }
  }

  /** Fetch fresh data from the sheet and update cache */
  async sync({ csvUrl }: { csvUrl?: string }) {
    const target = csvUrl ?? this.csvUrl;
    if (!target) {
      throw new Error(
        'No community sheet is configured. Set AIDEN_AI_SHEET_CSV_URL to opt into the live sheet; ' +
          'the bundled dataset is the default recipe source.'
      );
    }

    // One deadline covers the redirect chain and the body read: a response that trickles forever
    // would otherwise hang start(), which awaits ensureCached() before the transport connects.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let csv: string;
    let url: string;
    try {
      const fetched = await fetchAllowedSheet(target, controller.signal);
      url = fetched.url;

      if (!fetched.res.ok) {
        throw new Error(`The sheet host answered ${fetched.res.status}, so the CSV could not be fetched.`);
      }

      assertParseableContentType(fetched.res);
      csv = await readCappedText(fetched.res, SHEET_MAX_BYTES);
    } finally {
      clearTimeout(timeout);
    }

    const profiles = parseProfiles(csv);
    // A sign-in or error page served as text/csv parses without throwing, but every column fails
    // sanitizing, so the result is an empty list. Persisting that would replace a good cache with
    // an empty one and take the recipe source dark until the next successful sync, so treat an
    // empty parse as a failed sync: leave the cache alone and let the caller hear about it.
    if (profiles.length === 0) {
      throw new Error('The sheet CSV held no usable recipes, so the previous cache was kept.');
    }

    const cache: Cache = { cachedAtMs: Date.now(), csvUrl: url, profiles };

    await mkdir(getAppDataDir(), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf8');

    return { ok: true, csvUrl: url, profileCount: profiles.length };
  }

  /** Get cached profiles */
  async getProfiles(): Promise<SanitizedSheetProfile[]> {
    // An unconfigured store never serves sheet data, not even a cache a previously configured run
    // left on disk: opting out has to actually stop the stranger-written recipes from coming back.
    if (!this.isConfigured()) return [];

    const cached = await this.readCache();
    if (cached) return cached.profiles;

    // Nothing on disk yet. If a warm-up is already running, wait it out rather than answering
    // with an empty sheet; the fetch is deadline-bounded, so this cannot wait forever.
    if (this.warmup) {
      await this.warmup;
      return (await this.readCache())?.profiles ?? [];
    }

    return [];
  }

  private async readCache(): Promise<Cache | null> {
    try {
      const raw = JSON.parse(await readFile(this.cachePath, 'utf8')) as {
        cachedAtMs?: unknown;
        csvUrl?: unknown;
        profiles?: unknown;
      };
      if (typeof raw.cachedAtMs !== 'number' || typeof raw.csvUrl !== 'string' || !Array.isArray(raw.profiles)) {
        return null;
      }

      const profiles = raw.profiles
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const { validation: _cachedValidation, ...fields } = entry as Record<string, unknown>;
          if (!Object.values(fields).every((value) => typeof value === 'string')) return null;
          return sanitizeProfile(fields as Record<string, string>);
        })
        .filter((profile): profile is SanitizedSheetProfile => profile !== null);

      return { cachedAtMs: raw.cachedAtMs, csvUrl: raw.csvUrl, profiles };
    } catch {
      return null;
    }
  }
}
