/**
 * End-to-end regression suite for the sheet hardening epic (aiden-recipe-generator-nh5).
 *
 * Each case drives a hostile sheet through the real fetch/parse/sanitize/quarantine path with the
 * network stubbed, and asserts the guard that was added for it still holds. The point is coverage
 * of the whole chain against realistic attacker input, not of any single function — a fixture that
 * gets past one layer must still be stopped, or defanged, by the next.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SHEET_MAX_BYTES, SHEET_MAX_RECORD_CHARS } from '@/config';
import { AidenCreateProfileSchema } from '@/schemas';
import type { SheetProfile } from '@/sheet/store';
import { SheetProfileStore } from '@/sheet/store';
import { registerSheetTools } from '@/tools/sheet';
import {
  BlockedNetworkCallError,
  blockedNetworkCalls,
  clearBlockedNetworkCalls,
  csvResponse,
  freshDataDir,
  respondWith,
  withFetch
} from './helpers/offline';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/test/export?format=csv';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const ZWSP = '​';

const fixture = (name: string) => readFileSync(`test/fixtures/${name}`, 'utf8');

/** Sync a CSV body through the store and return the profiles it was willing to keep. */
async function profilesFrom(csv: string, contentType = 'text/csv'): Promise<SheetProfile[]> {
  freshDataDir();
  return withFetch(respondWith(() => csvResponse(csv, contentType)), async () => {
    const store = new SheetProfileStore({ csvUrl: SHEET_URL });
    await store.sync({});
    return store.getProfiles();
  });
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Run a CSV all the way out through the sheet.list tool, as an agent would see it. */
async function sheetListText(csv: string): Promise<{ text: string; structured: Record<string, unknown> }> {
  freshDataDir();
  return withFetch(respondWith(() => csvResponse(csv)), async () => {
    const store = new SheetProfileStore({ csvUrl: SHEET_URL });
    await store.sync({});

    const handlers = new Map<string, ToolHandler>();
    const stub = {
      registerTool(name: string, _config: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      }
    };
    registerSheetTools(stub as unknown as McpServer, store);

    const res = await handlers.get('sheet.list')?.({});
    if (!res) throw new Error('sheet.list was not registered');
    return { text: res.content[0]?.text ?? '', structured: res.structuredContent };
  });
}

describe('the suite itself never reaches the network', () => {
  test('an un-stubbed fetch is refused instead of hitting docs.google.com', async () => {
    clearBlockedNetworkCalls();
    freshDataDir();

    await expect(new SheetProfileStore({ csvUrl: SHEET_URL }).sync({})).rejects.toThrow(BlockedNetworkCallError);
    expect(blockedNetworkCalls()).toEqual([SHEET_URL]);
    clearBlockedNetworkCalls();
  });

  test('a warm-up with no stub swallows the block rather than falling back to the real host', async () => {
    clearBlockedNetworkCalls();
    freshDataDir();

    const store = new SheetProfileStore({ csvUrl: SHEET_URL });
    await expect(store.warmCache()).resolves.toBeUndefined();
    expect(await store.getProfiles()).toEqual([]);
    clearBlockedNetworkCalls();
  });
});

describe('prompt-injection fixture (nh5.7, nh5.8)', () => {
  test('injected instructions survive only as quarantined data, never as bare tool text', async () => {
    const { text, structured } = await sheetListText(fixture('sheet-injection.csv'));

    const begin = text.indexOf('<<<BEGIN_UNTRUSTED_COMMUNITY_SHEET_DATA>>>');
    expect(begin).toBeGreaterThanOrEqual(0);
    // Nothing attacker-written appears before the warning; the reader is told first.
    expect(text.slice(0, begin)).not.toMatch(/IGNORE PREVIOUS INSTRUCTIONS/i);
    expect(structured.dataTrust).toBe('untrusted-community-sheet');
  });
});

describe('control characters and invisible text (nh5.7)', () => {
  test('escapes, raw control bytes, and zero-width characters never reach the agent', async () => {
    const { text } = await sheetListText(fixture('sheet-control-chars.csv'));

    for (const char of [ESC, BEL, NUL, ZWSP]) expect(text).not.toContain(char);
    // Titles keep their readable text once the escapes around them are stripped.
    expect(text).toContain('Red Title');
    // The zero-width space inside "Zero<ZWSP>Width" is removed outright, not turned into a gap.
    expect(text).toContain('ZeroWidth');
  });

  test('a terminal escape glued to a temperature drops the field instead of coercing it', async () => {
    const profiles = await profilesFrom(fixture('sheet-control-chars.csv'));

    expect(profiles).toHaveLength(3);
    // `ESC[2J98` is not a number, and a numeric field only keeps values that parse in range.
    expect(profiles[2]).not.toHaveProperty('bloomTemp');
    expect(profiles[0]?.bloomTemp).toBe('99');
  });
});

describe('oversized cells (nh5.6, nh5.7)', () => {
  test('a 10 KB cell is truncated to the text cap, not passed through', async () => {
    const huge = 'A'.repeat(10_000);
    const csv = [`Recipe,Big`, `Origin,${huge}`, 'Roast,Light'].join('\n');

    const profiles = await profilesFrom(csv);
    expect(profiles[0]?.origin?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(profiles)).not.toContain(huge);
  });

  test('a single record past the parser cap is rejected outright', async () => {
    const csv = `Recipe,${'x'.repeat(SHEET_MAX_RECORD_CHARS + 1_000)}\nOrigin,Ethiopia\nRoast,Light\n`;
    await expect(profilesFrom(csv)).rejects.toThrow();
  });
});

describe('CSV bombs (nh5.4, nh5.6)', () => {
  test('an unterminated quote cannot swallow the sheet into one giant cell', async () => {
    // The opening quote in the header eats every following line, so the sheet collapses to a
    // single record instead of a grid — it is refused rather than parsed into one huge profile.
    await expect(profilesFrom(fixture('sheet-csv-bomb.csv'))).rejects.toThrow(/empty\/unexpected/i);
  });

  test('a quote bomb big enough to matter trips the record cap before it is buffered', async () => {
    const csv = `Recipe,"${'a,'.repeat(SHEET_MAX_RECORD_CHARS)}\nOrigin,Ethiopia\nRoast,Light\n`;
    await expect(profilesFrom(csv)).rejects.toThrow();
  });

  test('an endlessly expanding body is aborted at the byte cap', async () => {
    freshDataDir();
    const chunk = new Uint8Array(128 * 1024).fill(0x2c); // ','
    let served = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += chunk.byteLength;
        controller.enqueue(chunk);
      }
    });

    await withFetch(respondWith(() => csvResponse(endless)), async () => {
      await expect(new SheetProfileStore({ csvUrl: SHEET_URL }).sync({})).rejects.toThrow(/exceeded the \d+ byte limit/i);
    });
    expect(served).toBeLessThan(SHEET_MAX_BYTES * 2);
  });
});

describe('an HTML page served as the sheet (nh5.4)', () => {
  test('the honest content-type is refused before the parser sees it', async () => {
    await expect(profilesFrom(fixture('sheet-html-error.csv'), 'text/html')).rejects.toThrow(
      /expected one of text\/csv/i
    );
  });

  test('a sign-in page lying about its type is a failed sync, not an empty sheet', async () => {
    // Content-type is attacker-controlled, so the type check alone is not enough: the parse has to
    // fail closed. No column survives sanitizing, and a parse with nothing left is reported as a
    // failure rather than written to the cache (aiden-recipe-generator-kdm).
    freshDataDir();
    await withFetch(respondWith(() => csvResponse(fixture('sheet-html-error.csv'))), async () => {
      const store = new SheetProfileStore({ csvUrl: SHEET_URL });
      await expect(store.sync({})).rejects.toThrow(/no usable profiles/i);
      expect(await store.getProfiles()).toEqual([]);
    });
  });

  test('a sign-in page cannot overwrite a good cache', async () => {
    // The realistic failure: the sheet was fetched fine this morning, and now the export endpoint
    // answers with a sign-in page. The cached recipes have to survive that.
    freshDataDir();
    const store = new SheetProfileStore({ csvUrl: SHEET_URL });

    await withFetch(respondWith(() => csvResponse(fixture('sheet-sample.csv'))), () => store.sync({}));
    const good = await store.getProfiles();
    expect(good.length).toBeGreaterThan(0);

    await withFetch(respondWith(() => csvResponse(fixture('sheet-html-error.csv'))), async () => {
      await expect(store.sync({})).rejects.toThrow(/no usable profiles/i);
    });
    expect(await store.getProfiles()).toEqual(good);
  });
});

describe('redirects into the local network (nh5.2)', () => {
  const targets = [
    'https://127.0.0.1:8080/sheet.csv',
    'https://localhost/secrets.csv',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://docs.google.com/downgraded.csv',
    'file:///etc/passwd'
  ];

  for (const location of targets) {
    test(`a 302 to ${location} is refused, and the hop is never requested`, async () => {
      freshDataDir();
      const requested: string[] = [];

      const stub = respondWith((url) => {
        requested.push(url);
        return new Response(null, { status: 302, headers: { location } });
      });

      await withFetch(stub, async () => {
        await expect(new SheetProfileStore({ csvUrl: SHEET_URL }).sync({})).rejects.toThrow(
          /not an allowed sheet host|must use https|not a valid URL/i
        );
      });

      expect(requested).toEqual([SHEET_URL]);
    });
  }
});

describe('out-of-range brew values (nh5.7, nh5.9)', () => {
  test('a sheet temperature past boiling is dropped before it can seed a profile', async () => {
    const csv = ['Recipe,Scorched', 'Origin,Ethiopia', 'Roast,Light', 'Bloom Temp,250', 'Brew Ratio,999'].join('\n');

    const profiles = await profilesFrom(csv);
    expect(profiles[0]?.title).toBe('Scorched');
    expect(profiles[0]).not.toHaveProperty('bloomTemp');
    expect(profiles[0]).not.toHaveProperty('brewRatio');
  });

  test('and if one somehow got through, the device write still refuses it', async () => {
    const attempt = {
      title: 'Scorched',
      ratio: 16.5,
      bloomEnabled: true,
      bloomRatio: 2,
      bloomDuration: 45,
      bloomTemperature: 250
    };
    expect(AidenCreateProfileSchema.safeParse(attempt).success).toBe(false);
  });
});
