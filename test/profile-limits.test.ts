import { describe, expect, test } from 'bun:test';
import { AidenCreateProfileSchema, AidenUpdateProfileSchema } from '@/schemas';

/** A plausible light-roast recipe, the shape a real profile takes. */
const realProfile = {
  title: 'Ethiopia Guji Washed',
  ratio: 16.5,
  bloomEnabled: true,
  bloomRatio: 2,
  bloomDuration: 45,
  bloomTemperature: 96.5,
  ssPulsesEnabled: true,
  ssPulsesNumber: 3,
  ssPulsesInterval: 23,
  ssPulseTemperatures: [96.5, 95, 94],
  batchPulsesEnabled: true,
  batchPulsesNumber: 2,
  batchPulsesInterval: 30,
  batchPulseTemperatures: [96, 95]
};

describe('AidenCreateProfileSchema', () => {
  test('accepts a real recipe', () => {
    expect(AidenCreateProfileSchema.safeParse(realProfile).success).toBe(true);
  });

  test('rejects temperatures outside the brewer range', () => {
    for (const bloomTemperature of [0, 49.5, 99.5, 212, 1000, -5]) {
      expect(AidenCreateProfileSchema.safeParse({ ...realProfile, bloomTemperature }).success).toBe(false);
    }
  });

  test('rejects temperatures off the half-degree step', () => {
    expect(AidenCreateProfileSchema.safeParse({ ...realProfile, bloomTemperature: 96.25 }).success).toBe(false);
  });

  test('rejects absurd ratios', () => {
    for (const ratio of [0, 1, 13.5, 21, 1000]) {
      expect(AidenCreateProfileSchema.safeParse({ ...realProfile, ratio }).success).toBe(false);
    }
  });

  test('rejects an oversized pulse array', () => {
    const ssPulseTemperatures = Array.from({ length: 500 }, () => 96);
    expect(AidenCreateProfileSchema.safeParse({ ...realProfile, ssPulseTemperatures }).success).toBe(false);
  });

  test('rejects more pulse temperatures than configured pulses', () => {
    const result = AidenCreateProfileSchema.safeParse({
      ...realProfile,
      ssPulsesNumber: 2,
      ssPulseTemperatures: [96, 95, 94]
    });
    expect(result.success).toBe(false);
  });

  test('rejects out-of-range pulse counts, intervals, and bloom values', () => {
    const outOfRange = [
      { ssPulsesNumber: 0 },
      { ssPulsesNumber: 11 },
      { batchPulsesNumber: 99 },
      { ssPulsesInterval: 4 },
      { batchPulsesInterval: 61 },
      { bloomDuration: 0 },
      { bloomDuration: 121 },
      { bloomRatio: 0.5 },
      { bloomRatio: 4 }
    ];
    for (const patch of outOfRange) {
      expect(AidenCreateProfileSchema.safeParse({ ...realProfile, ...patch }).success).toBe(false);
    }
  });

  test('rejects titles the firmware would not accept', () => {
    for (const title of ['', 'a'.repeat(51), 'Guji\nDROP TABLE', 'café ☕', 'note<script>']) {
      expect(AidenCreateProfileSchema.safeParse({ ...realProfile, title }).success).toBe(false);
    }
  });
});

describe('AidenUpdateProfileSchema', () => {
  test('accepts a partial patch within range', () => {
    expect(AidenUpdateProfileSchema.safeParse({ bloomTemperature: 94 }).success).toBe(true);
    expect(AidenUpdateProfileSchema.safeParse({}).success).toBe(true);
  });

  test('applies the same bounds as create', () => {
    for (const patch of [
      { bloomTemperature: 150 },
      { overallTemperature: 120 },
      { ratio: 40 },
      { ssPulsesInterval: 600 },
      { duration: 100_000 },
      { batchPulseTemperatures: Array.from({ length: 50 }, () => 96) }
    ]) {
      expect(AidenUpdateProfileSchema.safeParse(patch).success).toBe(false);
    }
  });

  test('checks pulse temperatures against the pulse count when both are patched', () => {
    expect(
      AidenUpdateProfileSchema.safeParse({ batchPulsesNumber: 1, batchPulseTemperatures: [96, 95] }).success
    ).toBe(false);
    expect(AidenUpdateProfileSchema.safeParse({ batchPulseTemperatures: [96, 95] }).success).toBe(true);
  });
});
