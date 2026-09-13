import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SHEET_MAX_COLUMNS, SHEET_MAX_RECORD_CHARS, SHEET_MAX_ROWS } from '@/config';
import { profilesFromCsv as syncCsv } from './helpers/sheet';

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
