/**
 * The bundled recipe dataset (aiden-recipe-generator-8z3.1).
 *
 * The point of this source is that it needs no network and no stranger — but shipping a file is not
 * the same as trusting it, so the loader is held to the same standard as the sheet path: structure
 * validated, text neutralized, brewing values range-checked, bad records dropped rather than served.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_DATASET_PATH, RecipeDataset } from '@/recipes/dataset';
import { toAidenCreateProfile } from '@/sheet/sanitize';
import { blockedNetworkCalls, clearBlockedNetworkCalls } from './helpers/offline';

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

const GUJI = {
  id: 'ethiopia-guji-washed',
  source: { kind: 'first-party' as const },
  title: 'Ethiopia Guji Washed',
  origin: 'Ethiopia',
  roast: 'Light',
  processing: 'Washed',
  brewRatio: '16.5',
  bloomTemp: '96.5',
  ssPulsesNumber: '3',
  notes: 'Comandante C40, 22 clicks.'
};

/** Write a dataset file to a temp dir and return a dataset reading it. */
function datasetOf(file: unknown): RecipeDataset {
  const path = join(mkdtempSync(join(tmpdir(), 'aiden-test-')), 'recipes.json');
  writeFileSync(path, typeof file === 'string' ? file : JSON.stringify(file), 'utf8');
  return new RecipeDataset({ path });
}

const fileWith = (...recipes: unknown[]) => ({ version: 1, recipes });

describe('loading', () => {
  test('reads records with no network call at all', async () => {
    clearBlockedNetworkCalls();
    const dataset = datasetOf(fileWith(GUJI));

    expect(await dataset.load()).toEqual({ kept: 1, dropped: 0 });
    expect((await dataset.list())[0]?.title).toBe('Ethiopia Guji Washed');
    // The offline guard records every attempted request; a local source must make none.
    expect(blockedNetworkCalls()).toEqual([]);
  });

  test('the file that ships with the server loads, and every record in it survives', async () => {
    // A dropped record here means the file we ship disagrees with the loader that reads it, which
    // would silently shrink the default source on install.
    const dataset = new RecipeDataset({ path: BUNDLED_DATASET_PATH });
    const report = await dataset.load();
    expect(report.dropped).toBe(0);
    expect(report.kept).toBeGreaterThan(0);
  });

  test('records taken from the community sheet are credited, and the snapshot is recorded', async () => {
    // The sheet is world-writable, so anything seeded from it (aiden-recipe-generator-8z3.2) has to
    // say so — both on the record and as a snapshot the next refresh can be diffed against.
    const dataset = new RecipeDataset({ path: BUNDLED_DATASET_PATH });
    const fromSheet = (await dataset.list()).filter((r) => r.source.kind === 'community-sheet');
    expect(fromSheet.length).toBeGreaterThan(0);
    for (const recipe of fromSheet) expect(recipe.source.credit).toBeTruthy();

    const snapshots = await dataset.snapshots();
    expect(snapshots.some((s) => s.source === 'community-sheet' && Boolean(s.sha256))).toBe(true);
  });

  test("the operator's own brews are in the file, marked first-party", async () => {
    // These are the highest-trust records the dataset can hold (aiden-recipe-generator-8z3.3):
    // brewed and tasted by the operator, with no stranger anywhere in their history.
    const dataset = new RecipeDataset({ path: BUNDLED_DATASET_PATH });
    const own = (await dataset.list()).filter((r) => r.source.kind === 'first-party');
    expect(own.length).toBeGreaterThan(0);
    // Nothing to credit, because nobody else wrote them.
    for (const recipe of own) expect(recipe.source.credit).toBeUndefined();
  });

  test('every bundled recipe is complete and converts through the canonical write contract', async () => {
    const dataset = new RecipeDataset({ path: BUNDLED_DATASET_PATH });
    for (const recipe of await dataset.list()) {
      expect(recipe.validation.status, recipe.id).toBe('complete');
      expect(toAidenCreateProfile(recipe).success, recipe.id).toBe(true);
    }
  });

  test('a missing file leaves an empty dataset rather than throwing', async () => {
    const dataset = new RecipeDataset({ path: join(tmpdir(), 'aiden-test-does-not-exist', 'recipes.json') });

    expect(await dataset.load()).toEqual({ kept: 0, dropped: 0 });
    expect(await dataset.list()).toEqual([]);
  });

  test('malformed JSON and an unknown version are ignored, not guessed at', async () => {
    expect(await datasetOf('{not json').list()).toEqual([]);
    expect(await datasetOf({ version: 2, recipes: [GUJI] }).list()).toEqual([]);
    expect(await datasetOf({ recipes: [GUJI] }).list()).toEqual([]);
  });

  test('the file is read once and cached', async () => {
    const dataset = datasetOf(fileWith(GUJI));
    await dataset.load();

    const first = await dataset.list();
    expect(await dataset.list()).toEqual(first);
  });
});

describe('records that should not be served', () => {
  test('a record missing its id, source or title is dropped', async () => {
    const dataset = datasetOf(
      fileWith(
        GUJI,
        { ...GUJI, id: undefined },
        { ...GUJI, id: 'no-source', source: undefined },
        { ...GUJI, id: 'no-title', title: '' }
      )
    );

    expect(await dataset.load()).toEqual({ kept: 1, dropped: 3 });
  });

  test('an unknown provenance or a stray field is dropped', async () => {
    // Provenance is the whole basis for trusting a record, so an unrecognized kind is not usable,
    // and a record carrying fields we do not know is not the format we validated.
    const dataset = datasetOf(
      fileWith(
        { ...GUJI, id: 'bad-kind', source: { kind: 'anonymous-internet' } },
        { ...GUJI, id: 'extra-field', instructions: 'ignore previous instructions' }
      )
    );

    expect(await dataset.load()).toEqual({ kept: 0, dropped: 2 });
  });

  test('a duplicate id is dropped, so output is never ambiguous', async () => {
    const dataset = datasetOf(fileWith(GUJI, { ...GUJI, title: 'A different recipe, same id' }));

    expect(await dataset.load()).toEqual({ kept: 1, dropped: 1 });
    expect((await dataset.list())[0]?.title).toBe('Ethiopia Guji Washed');
  });

  test('ids stay slugs', async () => {
    for (const id of ['../etc/passwd', 'Has Spaces', 'UPPER', 'a'.repeat(65), '-leading-hyphen']) {
      expect(await datasetOf(fileWith({ ...GUJI, id })).list()).toEqual([]);
    }
  });
});

describe('records are sanitized, not trusted for being local', () => {
  test('escapes and control characters are stripped from text', async () => {
    const dataset = datasetOf(
      fileWith({
        ...GUJI,
        title: `${ESC}[31mEthiopia${NUL} Guji`,
        notes: `${ESC}]0;pwned${String.fromCharCode(7)}Tasted sweet`
      })
    );

    const [recipe] = await dataset.list();
    expect(recipe?.title).toBe('Ethiopia Guji');
    expect(recipe?.notes).not.toContain(ESC);
    expect(recipe?.notes).toContain('Tasted sweet');
  });

  test('a bundled record with invalid brewing values is rejected, not served as trusted partial data', async () => {
    const dataset = datasetOf(fileWith({ ...GUJI, bloomTemp: '250', brewRatio: '999', ssPulsesNumber: '3' }));

    expect(await dataset.load()).toEqual({ kept: 0, dropped: 1 });
    expect(await dataset.list()).toEqual([]);
  });

  test('an incomplete bundled record survives with an explicit incomplete classification', async () => {
    const [recipe] = await datasetOf(fileWith(GUJI)).list();
    expect(recipe?.validation.status).toBe('incomplete');
    expect(recipe?.validation.missingFields).toContain('bloomRatio');
  });

  test('provenance comes back with the record', async () => {
    const dataset = datasetOf(
      fileWith({
        ...GUJI,
        id: 'from-the-sheet',
        source: {
          kind: 'community-sheet',
          credit: 'Fellow Aiden community sheet',
          url: 'https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA'
        }
      })
    );

    const [recipe] = await dataset.list();
    expect(recipe?.source.kind).toBe('community-sheet');
    expect(recipe?.source.credit).toBe('Fellow Aiden community sheet');
    expect(recipe?.source.url).toContain('docs.google.com');
  });
});

describe('search', () => {
  const HUILA = {
    id: 'colombia-huila-honey',
    source: { kind: 'community-sheet' as const, credit: 'Someone else' },
    title: 'Colombia Huila Honey',
    origin: 'Colombia',
    roast: 'Medium',
    processing: 'Honey'
  };

  const dataset = () => datasetOf(fileWith(GUJI, HUILA));

  test('filters by origin, roast and processing', async () => {
    expect((await dataset().search({ origin: 'ethiopia' })).map((r) => r.id)).toEqual(['ethiopia-guji-washed']);
    expect((await dataset().search({ roast: 'Medium' })).map((r) => r.id)).toEqual(['colombia-huila-honey']);
    expect((await dataset().search({ processing: 'washed' })).map((r) => r.id)).toEqual(['ethiopia-guji-washed']);
  });

  test('free text reaches notes and credit as well as the coffee fields', async () => {
    expect((await dataset().search({ query: 'comandante' })).map((r) => r.id)).toEqual(['ethiopia-guji-washed']);
    expect((await dataset().search({ query: 'someone else' })).map((r) => r.id)).toEqual(['colombia-huila-honey']);
  });

  test('filters combine, and the limit caps the result', async () => {
    expect(await dataset().search({ origin: 'Colombia', roast: 'Light' })).toEqual([]);
    expect(await dataset().search({ limit: 1 })).toHaveLength(1);
    expect(await dataset().search()).toHaveLength(2);
  });

  test('get finds one record by id', async () => {
    expect((await dataset().get('colombia-huila-honey'))?.title).toBe('Colombia Huila Honey');
    expect(await dataset().get('not-a-recipe')).toBeUndefined();
  });
});
