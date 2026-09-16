import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profilesFromCsv as parseFixture } from './helpers/sheet';

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
    await expect(parseFixture('Recipe,Only One Row\n')).rejects.toThrow(/too few rows/i);
  });
});
