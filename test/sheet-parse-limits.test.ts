import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHEET_MAX_COLUMNS, SHEET_MAX_RECORD_CHARS, SHEET_MAX_ROWS } from '@/config';
import { SheetProfileStore } from '@/sheet/store';

const URL_OK = 'https://docs.google.com/spreadsheets/d/test/export?format=csv';

/** Feed a CSV through the store with fetch stubbed and the data dir redirected to a temp dir. */
async function syncCsv(csv: string) {
  process.env.AIDEN_AI_DATA_DIR = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })) as unknown as typeof fetch;
  try {
    const store = new SheetProfileStore({ csvUrl: URL_OK });
    await store.sync({});
    return await store.getProfiles();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('CSV shape limits', () => {
  test('the real sheet fixture still parses to the same profiles', async () => {
    const profiles = await syncCsv(readFileSync('test/fixtures/sheet-sample.csv', 'utf8'));
    expect(profiles).toHaveLength(3);
    expect(profiles[0]?.title).toBe('Ethiopia Guji Light');
  });

  test('a sheet wider than the column cap is rejected, not truncated', async () => {
    const cols = SHEET_MAX_COLUMNS + 10;
    const csv = [
      ['Coffee', ...Array.from({ length: cols }, (_, i) => `c${i}`)].join(','),
      ['Origin', ...Array.from({ length: cols }, () => 'Ethiopia')].join(','),
      ['Roast', ...Array.from({ length: cols }, () => 'Light')].join(',')
    ].join('\n');

    await expect(syncCsv(csv)).rejects.toThrow(/more than \d+ recipe columns/i);
  });

  test('a sheet longer than the row cap is rejected, not truncated', async () => {
    const csv = Array.from({ length: SHEET_MAX_ROWS + 10 }, (_, i) => `Label${i},value`).join('\n');
    await expect(syncCsv(csv)).rejects.toThrow(/more than \d+ rows/i);
  });

  test('a single oversized record is rejected by the parser', async () => {
    const csv = `Coffee,${'x'.repeat(SHEET_MAX_RECORD_CHARS + 1_000)}\nOrigin,Ethiopia\nRoast,Light\n`;
    await expect(syncCsv(csv)).rejects.toThrow();
  });

  test('a sheet right at the caps still parses', async () => {
    const cols = SHEET_MAX_COLUMNS;
    const filler = Array.from({ length: SHEET_MAX_ROWS - 3 }, (_, i) => `Ignored${i}`);
    const csv = [
      ['Coffee', ...Array.from({ length: cols }, (_, i) => `c${i}`)].join(','),
      ['Origin', ...Array.from({ length: cols }, () => 'Ethiopia')].join(','),
      ['Roast', ...Array.from({ length: cols }, () => 'Light')].join(','),
      ...filler.map((label) => `${label},x`)
    ].join('\n');

    const profiles = await syncCsv(csv);
    expect(profiles).toHaveLength(cols);
  });
});
