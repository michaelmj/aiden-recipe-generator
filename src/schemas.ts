/**
 * Zod schemas for Aiden profile API payloads.
 * Used for validation and type inference.
 */

import * as z from 'zod/v4';

/**
 * Physical limits the Aiden firmware accepts, mirrored from the reverse-engineered
 * `fellow-aiden` profile model (https://github.com/9b/fellow-aiden).
 * Profile values can originate from the community sheet or from a model that made a number up,
 * so they are bounded here — before any HTTP call reaches the brewer. See docs/THREAT-MODEL.md.
 */
export const AIDEN_LIMITS = {
  /** Water:coffee ratio, in 0.5 steps */
  ratio: { min: 14, max: 20, step: 0.5 },
  /** Bloom water as a multiple of coffee weight, in 0.5 steps */
  bloomRatio: { min: 1, max: 3, step: 0.5 },
  /** Bloom duration in seconds */
  bloomDuration: { min: 1, max: 120 },
  /** Every temperature the device brews at, in Celsius, in 0.5 steps */
  temperature: { min: 50, max: 99, step: 0.5 },
  /** Pulses per brew */
  pulsesNumber: { min: 1, max: 10 },
  /** Seconds between pulses */
  pulsesInterval: { min: 5, max: 60 },
  /** Total brew duration in seconds, as reported back by the device */
  duration: { min: 0, max: 3600 },
  title: { max: 50 }
} as const;

/**
 * Titles are shown on the brewer's display and stored by Fellow, so the character set is held to
 * what the firmware accepts. This also keeps sheet-derived newlines and control characters out.
 */
const TitleSchema = z
  .string()
  .min(1)
  .max(AIDEN_LIMITS.title.max)
  .regex(
    /^[A-Za-z0-9 !@#$%&*\-+?/.,:)(]+$/,
    'Titles may contain only letters, digits, spaces, and the specials !@#$%&*-+?/.,:)('
  );

const TemperatureSchema = z
  .number()
  .min(AIDEN_LIMITS.temperature.min)
  .max(AIDEN_LIMITS.temperature.max)
  .multipleOf(AIDEN_LIMITS.temperature.step);

/**
 * One temperature per pulse, so the array can never be longer than the pulse maximum.
 * An unbounded array would otherwise be forwarded verbatim to the device.
 */
const PulseTemperaturesSchema = z.array(TemperatureSchema).max(AIDEN_LIMITS.pulsesNumber.max);

const RatioSchema = z
  .number()
  .min(AIDEN_LIMITS.ratio.min)
  .max(AIDEN_LIMITS.ratio.max)
  .multipleOf(AIDEN_LIMITS.ratio.step);

const BloomRatioSchema = z
  .number()
  .min(AIDEN_LIMITS.bloomRatio.min)
  .max(AIDEN_LIMITS.bloomRatio.max)
  .multipleOf(AIDEN_LIMITS.bloomRatio.step);

const BloomDurationSchema = z.number().int().min(AIDEN_LIMITS.bloomDuration.min).max(AIDEN_LIMITS.bloomDuration.max);

const PulsesNumberSchema = z.number().int().min(AIDEN_LIMITS.pulsesNumber.min).max(AIDEN_LIMITS.pulsesNumber.max);

const PulsesIntervalSchema = z.number().int().min(AIDEN_LIMITS.pulsesInterval.min).max(AIDEN_LIMITS.pulsesInterval.max);

/**
 * A pulse temperature list longer than the pulse count would leave the device with instructions it
 * never asked for, so the two are checked against each other whenever both are present.
 */
function checkPulseTemperatureCount(
  ctx: z.RefinementCtx,
  field: 'ssPulseTemperatures' | 'batchPulseTemperatures',
  temperatures: number[] | null | undefined,
  count: number | null | undefined
) {
  if (!temperatures || typeof count !== 'number') return;
  if (temperatures.length > count) {
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `${field} has ${temperatures.length} entries but only ${count} pulses are configured.`
    });
  }
}

/** Schema for creating a new brew profile */
export const AidenCreateProfileSchema = z
  .object({
    profileType: z.number().int().min(0).max(10).default(0),
    title: TitleSchema,
    overallTemperature: TemperatureSchema.optional().nullable(),
    ratio: RatioSchema,
    bloomEnabled: z.boolean(),
    bloomRatio: BloomRatioSchema,
    bloomDuration: BloomDurationSchema,
    bloomTemperature: TemperatureSchema,
    ssPulsesEnabled: z.boolean(),
    ssPulsesNumber: PulsesNumberSchema,
    ssPulsesInterval: PulsesIntervalSchema,
    ssPulseTemperatures: PulseTemperaturesSchema.default([]),
    batchPulsesEnabled: z.boolean(),
    batchPulsesNumber: PulsesNumberSchema,
    batchPulsesInterval: PulsesIntervalSchema.default(30),
    batchPulseTemperatures: PulseTemperaturesSchema.default([])
  })
  .superRefine((profile, ctx) => {
    checkPulseTemperatureCount(ctx, 'ssPulseTemperatures', profile.ssPulseTemperatures, profile.ssPulsesNumber);
    checkPulseTemperatureCount(
      ctx,
      'batchPulseTemperatures',
      profile.batchPulseTemperatures,
      profile.batchPulsesNumber
    );
  });

export type AidenCreateProfileInput = z.infer<typeof AidenCreateProfileSchema>;

/** Schema for updating an existing profile (all fields optional) */
export const AidenUpdateProfileSchema = z
  .object({
    profileType: z.number().int().min(0).max(10).optional(),
    title: TitleSchema.optional(),
    ratio: RatioSchema.optional(),
    duration: z.number().int().min(AIDEN_LIMITS.duration.min).max(AIDEN_LIMITS.duration.max).optional(),
    bloomEnabled: z.boolean().optional(),
    overallTemperature: TemperatureSchema.optional().nullable(),
    bloomRatio: BloomRatioSchema.optional(),
    bloomDuration: BloomDurationSchema.optional(),
    bloomTemperature: TemperatureSchema.optional(),
    ssPulsesEnabled: z.boolean().optional(),
    ssPulsesNumber: PulsesNumberSchema.optional(),
    ssPulsesInterval: PulsesIntervalSchema.optional(),
    ssPulseTemperatures: PulseTemperaturesSchema.nullable().optional(),
    batchPulsesEnabled: z.boolean().optional(),
    batchPulsesNumber: PulsesNumberSchema.optional(),
    batchPulsesInterval: PulsesIntervalSchema.nullable().optional(),
    batchPulseTemperatures: PulseTemperaturesSchema.nullable().optional()
  })
  .superRefine((patch, ctx) => {
    checkPulseTemperatureCount(ctx, 'ssPulseTemperatures', patch.ssPulseTemperatures, patch.ssPulsesNumber);
    checkPulseTemperatureCount(ctx, 'batchPulseTemperatures', patch.batchPulseTemperatures, patch.batchPulsesNumber);
  });

export type AidenUpdateProfileInput = z.infer<typeof AidenUpdateProfileSchema>;

/**
 * Device and profile ids, as accepted from tool arguments.
 * These are interpolated into Fellow API request paths, so the character set is kept to what a
 * real id uses (uuid, serial, or opaque token) — no slashes, dots, query or fragment markers.
 */
export const ResourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Ids may contain only letters, digits, dot, underscore, colon, or hyphen.')
  .refine((id) => !id.includes('..') && id !== '.', 'Ids may not contain dot segments.');
