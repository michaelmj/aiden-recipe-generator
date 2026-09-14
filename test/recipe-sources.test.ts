/**
 * Recipe sources and their trust levels (aiden-recipe-generator-8z3.4).
 *
 * The point of this change is that the world-writable community sheet stopped being the thing the
 * server reaches for on its own. So what is worth pinning down is not that the tools return rows —
 * it is that an unconfigured server touches no network and serves only reviewed records, that an
 * operator who opts back in still gets the quarantine, and that a stale cache cannot smuggle
 * stranger-written recipes back in after the opt-in is removed.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppDataDir } from '@/config';
import { SheetProfileStore } from '@/sheet/store';
import {
  blockedNetworkCalls,
  clearBlockedNetworkCalls,
  csvResponse,
  freshDataDir,
  respondWith,
  withFetch
} from './helpers/offline';
import { captureTools, datasetOf, freshStore, SHEET_URL, sheetTools } from './helpers/sheet';

const SHEET_CSV = [
  'Name,Stranger Sheet Coffee',
  'Origin,Kenya',
  'Roast,Medium',
  'Processing,Washed',
  'Brew Ratio,16'
].join('\n');

const BUNDLED = {
  id: 'ethiopia-guji-washed',
  source: { kind: 'first-party' as const },
  title: 'Ethiopia Guji Washed',
  origin: 'Ethiopia',
  roast: 'Light',
  processing: 'Washed',
  brewRatio: '16.5'
};

type Record_ = { title: string; trust: string };
const records = (structured: Record<string, unknown>) => structured.profiles as Record_[];

/** Tools over a store with no AIDEN_AI_SHEET_CSV_URL — the default deployment. */
function unconfiguredTools(recipes: unknown[] = []) {
  freshDataDir();
  const previous = process.env.AIDEN_AI_SHEET_CSV_URL;
  delete process.env.AIDEN_AI_SHEET_CSV_URL;
  try {
    return captureTools(datasetOf(recipes), new SheetProfileStore());
  } finally {
    if (previous !== undefined) process.env.AIDEN_AI_SHEET_CSV_URL = previous;
  }
}

describe('with no sheet configured, the bundled dataset is the only source', () => {
  test('sheet.list serves bundled records and makes no network call', async () => {
    clearBlockedNetworkCalls();
    const tools = unconfiguredTools([BUNDLED]);

    const res = await tools.get('sheet.list')?.handler({});
    if (!res) throw new Error('sheet.list was not registered');

    expect(res.structuredContent.count).toBe(1);
    expect(records(res.structuredContent)[0]?.title).toBe('Ethiopia Guji Washed');
    expect(records(res.structuredContent)[0]?.trust).toBe('bundled-dataset');
    // The offline guard records every attempted fetch, so an empty list is proof of no request.
    expect(blockedNetworkCalls()).toHaveLength(0);
  });

  test('a bundled-only response is not wrapped in the untrusted delimiters', async () => {
    const tools = unconfiguredTools([BUNDLED]);
    const res = await tools.get('sheet.search')?.handler({ limit: 20 });
    if (!res) throw new Error('sheet.search was not registered');

    expect(res.structuredContent.dataTrust).toBe('bundled-dataset');
    expect(res.content[0]?.text ?? '').not.toContain('BEGIN_UNTRUSTED_COMMUNITY_SHEET_DATA');
  });

  test('sheet.sync reports that nothing is configured instead of fetching', async () => {
    clearBlockedNetworkCalls();
    const tools = unconfiguredTools();

    const res = await tools.get('sheet.sync')?.handler({});
    if (!res) throw new Error('sheet.sync was not registered');

    expect(res.structuredContent.ok).toBe(false);
    expect(res.structuredContent.configured).toBe(false);
    expect(String(res.structuredContent.message)).toMatch(/AIDEN_AI_SHEET_CSV_URL/);
    expect(blockedNetworkCalls()).toHaveLength(0);
  });

  test('a cache left by an earlier opted-in run is not served', async () => {
    const dir = freshDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(getAppDataDir(), 'sheetProfiles.json'),
      JSON.stringify({ cachedAtMs: Date.now(), csvUrl: SHEET_URL, profiles: [{ title: 'Left Over' }] }),
      'utf8'
    );

    const previous = process.env.AIDEN_AI_SHEET_CSV_URL;
    delete process.env.AIDEN_AI_SHEET_CSV_URL;
    try {
      expect(await new SheetProfileStore().getProfiles()).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.AIDEN_AI_SHEET_CSV_URL = previous;
    }
  });

  test('the store refuses to sync without a URL rather than falling back to one', async () => {
    freshDataDir();
    const previous = process.env.AIDEN_AI_SHEET_CSV_URL;
    delete process.env.AIDEN_AI_SHEET_CSV_URL;
    try {
      await expect(new SheetProfileStore().sync({})).rejects.toThrow(/No community sheet is configured/i);
    } finally {
      if (previous !== undefined) process.env.AIDEN_AI_SHEET_CSV_URL = previous;
    }
  });
});

describe('with a sheet configured, its records stay untrusted alongside bundled ones', () => {
  test('both sources are returned, each labelled with where it came from', async () => {
    const tools = await sheetTools(SHEET_CSV, [BUNDLED]);
    const res = await tools.get('sheet.list')?.handler({});
    if (!res) throw new Error('sheet.list was not registered');

    const byTitle = new Map(records(res.structuredContent).map((r) => [r.title, r.trust]));
    expect(byTitle.get('Ethiopia Guji Washed')).toBe('bundled-dataset');
    expect(byTitle.get('Stranger Sheet Coffee')).toBe('untrusted-community-sheet');
  });

  test('one sheet record quarantines the whole response', async () => {
    const tools = await sheetTools(SHEET_CSV, [BUNDLED]);
    const res = await tools.get('sheet.list')?.handler({});
    if (!res) throw new Error('sheet.list was not registered');

    expect(res.structuredContent.dataTrust).toBe('untrusted-community-sheet');
    expect(res.content[0]?.text ?? '').toContain('<<<BEGIN_UNTRUSTED_COMMUNITY_SHEET_DATA>>>');
  });

  test('bundled matches come first, so a truncated page drops sheet rows before reviewed ones', async () => {
    const tools = await sheetTools(SHEET_CSV, [BUNDLED]);
    const res = await tools.get('sheet.search')?.handler({ limit: 1 });
    if (!res) throw new Error('sheet.search was not registered');

    // count is the match total; profiles is the page, and the bundled record survives the cut.
    expect(res.structuredContent.count).toBe(2);
    expect(records(res.structuredContent)).toHaveLength(1);
    expect(records(res.structuredContent)[0]?.trust).toBe('bundled-dataset');
    // Nothing untrusted made the page, so there is nothing to quarantine.
    expect(res.structuredContent.dataTrust).toBe('bundled-dataset');
  });

  test('search filters both sources on the same fields', async () => {
    const tools = await sheetTools(SHEET_CSV, [BUNDLED]);
    const res = await tools.get('sheet.search')?.handler({ origin: 'kenya', limit: 20 });
    if (!res) throw new Error('sheet.search was not registered');

    expect(records(res.structuredContent).map((r) => r.title)).toEqual(['Stranger Sheet Coffee']);
    expect(res.structuredContent.dataTrust).toBe('untrusted-community-sheet');
  });

  test('sheet.sync still fetches and reports the URL it used', async () => {
    const store = freshStore();
    const res = await withFetch(
      respondWith(() => csvResponse(SHEET_CSV)),
      async () => captureTools(datasetOf(), store).get('sheet.sync')?.handler({})
    );
    if (!res) throw new Error('sheet.sync was not registered');

    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.configured).toBe(true);
    expect(res.structuredContent.csvUrl).toBe(SHEET_URL);
    expect(res.structuredContent.profileCount).toBe(1);
  });
});
