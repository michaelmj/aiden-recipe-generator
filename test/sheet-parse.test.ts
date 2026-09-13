import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Parses the fixture through SheetProfileStore with fetch stubbed and HOME redirected,
 * so no network call is made and the real user cache is never touched.
 */
async function parseFixture(csv: string) {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  const { SheetProfileStore } = await import('@/sheet/store');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch;
  try {
    const store = new SheetProfileStore({ csvUrl: 'https://example.invalid/sheet.csv' });
    await store.sync({});
    return await store.getProfiles();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('community sheet parsing', () => {
  test('maps a column-oriented sheet into profiles', async () => {
    const csv = readFileSync('test/fixtures/sheet-sample.csv', 'utf8');
    const profiles = await parseFixture(csv);

    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toMatchObject({
      title: 'Ethiopia Guji Light',
      origin: 'Ethiopia',
      roast: 'Light',
      processing: 'Washed',
      brewRatio: '16.5',
      bloomTemp: '99',
      ssPulseTemps: '99,98,97,96'
    });
    // Quoted title with embedded quotes survives.
    expect(profiles[2]?.title).toBe('Brazil "Fazenda" Dark');
    // Empty cells are dropped rather than stored as ''.
    expect(profiles[2]).not.toHaveProperty('batchPulsesInterval');
    // Unmapped label rows are ignored.
    expect(JSON.stringify(profiles)).not.toContain('whatever');
  });

  test('rejects a sheet with too few rows', async () => {
    await expect(parseFixture('Recipe,Only One Row\n')).rejects.toThrow(/empty|unexpected/i);
  });
});
