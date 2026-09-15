import { describe, expect, test } from 'bun:test';
import { sanitizeProfile, toAidenCreateProfile } from '@/sheet/sanitize';
import { sanitizeText, TEXT_MAX_CHARS, TITLE_MAX_CHARS } from '@/text';
import { profilesFromCsv as parseFixture } from './helpers/sheet';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const ZWSP = '\u200b';

describe('cell sanitizing', () => {
  test('strips ANSI escapes, control characters, and zero-width characters', () => {
    const dirty = `${ESC}[31mEthi${BEL}opia${ZWSP} Guji${ESC}[0m`;
    // ANSI sequences and zero-width characters vanish; a raw control byte becomes a space.
    expect(sanitizeText(dirty)).toBe('Ethi opia Guji');
  });

  test('caps text and title length', () => {
    expect(sanitizeText('x'.repeat(5_000))).toHaveLength(TEXT_MAX_CHARS);
    expect(sanitizeProfile({ title: 'y'.repeat(5_000) })?.title).toHaveLength(TITLE_MAX_CHARS);
  });

  test('drops fields outside the ranges an Aiden can brew', () => {
    const profile = sanitizeProfile({
      title: 'Out of range',
      bloomTemp: '250',
      brewRatio: '999',
      bloomTime: '99999',
      ssPulsesNumber: '4.5',
      batchPulsesInterval: '-30'
    });

    expect(profile).not.toBeNull();
    expect(profile).not.toHaveProperty('bloomTemp');
    expect(profile).not.toHaveProperty('brewRatio');
    expect(profile).not.toHaveProperty('bloomTime');
    expect(profile).not.toHaveProperty('ssPulsesNumber');
    expect(profile).not.toHaveProperty('batchPulsesInterval');
    expect(profile?.validation.status).toBe('invalid');
    expect(profile?.validation.issues.map((issue) => issue.field)).toEqual([
      'brewRatio',
      'bloomTime',
      'bloomTemp',
      'ssPulsesNumber',
      'batchPulsesInterval'
    ]);
  });

  test('keeps in-range brewing values in canonical form', () => {
    const profile = sanitizeProfile({
      title: 'In range',
      brewRatio: '16.5',
      bloomTemp: '99',
      ssPulsesNumber: '4',
      ssPulseTemps: "'99,98,97'"
    });

    expect(profile).toMatchObject({
      brewRatio: '16.5',
      bloomTemp: '99',
      ssPulsesNumber: '4',
      ssPulseTemps: '99,98,97'
    });
  });

  test('filters out-of-range entries from a pulse temp list', () => {
    expect(sanitizeProfile({ title: 'List', ssPulseTemps: '99,900,97,abc' })?.ssPulseTemps).toBe('99,97');
    expect(sanitizeProfile({ title: 'List', ssPulseTemps: '900,abc' })).not.toHaveProperty('ssPulseTemps');
    expect(sanitizeProfile({ title: 'List', ssPulseTemps: '99,900,97,abc' })?.validation.status).toBe('invalid');
  });

  test('uses canonical half-step and range rules from the write contract', () => {
    const profile = sanitizeProfile({
      title: 'Canonical edges',
      brewRatio: '14',
      bloomRatio: '3',
      bloomTime: '120',
      bloomTemp: '99',
      ssPulsesNumber: '10',
      ssPulsesInterval: '5',
      ssPulseTemps: '50,99',
      batchPulsesNumber: '1',
      batchPulsesInterval: '60',
      batchPulseTemps: '96.5'
    });
    expect(profile?.validation.status).toBe('complete');
    expect(
      sanitizeProfile({ title: 'Bad step', brewRatio: '16.25', bloomTemp: '96.25' })?.validation.issues
    ).toHaveLength(2);
  });

  test('surfaces pulse-count conflicts and does not expose the conflicting list', () => {
    const profile = sanitizeProfile({ title: 'Conflict', ssPulsesNumber: '2', ssPulseTemps: '96,95,94' });
    expect(profile?.validation.status).toBe('invalid');
    expect(profile?.validation.issues).toContainEqual({
      field: 'ssPulseTemps',
      code: 'conflict',
      message: 'ssPulseTemps has 3 entries but ssPulsesNumber is 2.'
    });
    expect(profile).not.toHaveProperty('ssPulseTemps');
  });

  test('distinguishes incomplete sources and converts complete sources to bounded writes', () => {
    const incomplete = sanitizeProfile({ title: 'Incomplete', brewRatio: '16' });
    expect(incomplete?.validation.status).toBe('incomplete');
    if (!incomplete) throw new Error('fixture title should survive');
    expect(toAidenCreateProfile(incomplete)).toMatchObject({ success: false, status: 'incomplete' });

    const complete = sanitizeProfile({
      title: 'Complete',
      brewRatio: '16',
      bloomRatio: '2',
      bloomTime: '45',
      bloomTemp: '96',
      ssPulsesNumber: '3',
      ssPulsesInterval: '23',
      ssPulseTemps: '96,95,94',
      batchPulsesNumber: '1',
      batchPulseTemps: '95'
    });
    if (!complete) throw new Error('fixture title should survive');
    const converted = toAidenCreateProfile(complete);
    expect(converted.success).toBe(true);
    if (converted.success) expect(converted.profile.batchPulsesInterval).toBe(30);
  });

  test('drops a row whose title does not survive sanitizing', () => {
    expect(sanitizeProfile({ title: `${ESC}[2J${NUL} ${ZWSP}`, origin: 'Ethiopia' })).toBeNull();
    expect(sanitizeProfile({ origin: 'Ethiopia' })).toBeNull();
  });
});

describe('hostile sheet parsed end to end', () => {
  const hugeCell = 'A'.repeat(10_000);
  const csv = [
    `Recipe,${ESC}[31mAnsi Title${ESC}[0m,"${hugeCell}",Out Of Range`,
    `Origin,Ethiopia,"${hugeCell}",Colombia`,
    'Roast,Light,Medium,Dark',
    'Brew Ratio,16.5,15.5,999',
    'Bloom Temp,99,95,250',
    'Single No. of Pulses on,4,3,99',
    'Single Pulse Temps,"99,98","95,94","250,300"'
  ].join('\n');

  test('control characters, 10 KB cells, and bad ranges never pass through raw', async () => {
    const profiles = await parseFixture(csv);
    const serialized = JSON.stringify(profiles);

    expect(profiles).toHaveLength(3);
    expect(serialized).not.toContain(ESC);
    expect(serialized).not.toContain(hugeCell);

    expect(profiles[0]?.title).toBe('Ansi Title');
    expect(profiles[1]?.title).toHaveLength(TITLE_MAX_CHARS);
    expect(profiles[1]?.origin).toHaveLength(TEXT_MAX_CHARS);

    const outOfRange = profiles[2];
    expect(outOfRange?.roast).toBe('Dark');
    expect(outOfRange).not.toHaveProperty('brewRatio');
    expect(outOfRange).not.toHaveProperty('bloomTemp');
    expect(outOfRange).not.toHaveProperty('ssPulsesNumber');
    expect(outOfRange).not.toHaveProperty('ssPulseTemps');
  });
});
