/**
 * Zod schemas for Aiden profile API payloads.
 * Used for validation and type inference.
 */

import * as z from 'zod/v4';

/**
 * Physical limits the Aiden firmware accepts, mirrored from the enums in the reverse-engineered
 * `fellow-aiden` profile model (`fellow_aiden/profile.py`, https://github.com/9b/fellow-aiden).
 * Profile values can originate from the community sheet or from a model that made a number up,
 * so they are bounded here — before any HTTP call reaches the brewer. See docs/THREAT-MODEL.md.
 *
 * `duration` is deliberately absent: the same reference client lists it in
 * SERVER_SIDE_PROFILE_FIELDS and strips it from the payload before POST and PATCH, so it is
 * computed by Fellow and is not ours to write (aiden-recipe-generator-iaf).
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
  title: { max: 50 }
} as const;

/**
 * Titles are shown on the brewer's display and stored by Fellow, so the character set is held to
 * what the firmware accepts. This also keeps sheet-derived newlines and control characters out.
 */
export const AidenTitleSchema = z
  .string()
  .min(1)
  .max(AIDEN_LIMITS.title.max)
  .regex(
    /^[A-Za-z0-9 !@#$%&*\-+?/.,:)(]+$/,
    'Titles may contain only letters, digits, spaces, and the specials !@#$%&*-+?/.,:)('
  );

export const AidenTemperatureSchema = z
  .number()
  .min(AIDEN_LIMITS.temperature.min)
  .max(AIDEN_LIMITS.temperature.max)
  .multipleOf(AIDEN_LIMITS.temperature.step);

/**
 * One temperature per pulse, so the array can never be longer than the pulse maximum.
 * An unbounded array would otherwise be forwarded verbatim to the device.
 */
export const AidenPulseTemperaturesSchema = z.array(AidenTemperatureSchema).max(AIDEN_LIMITS.pulsesNumber.max);

export const AidenRatioSchema = z
  .number()
  .min(AIDEN_LIMITS.ratio.min)
  .max(AIDEN_LIMITS.ratio.max)
  .multipleOf(AIDEN_LIMITS.ratio.step);

export const AidenBloomRatioSchema = z
  .number()
  .min(AIDEN_LIMITS.bloomRatio.min)
  .max(AIDEN_LIMITS.bloomRatio.max)
  .multipleOf(AIDEN_LIMITS.bloomRatio.step);

export const AidenBloomDurationSchema = z
  .number()
  .int()
  .min(AIDEN_LIMITS.bloomDuration.min)
  .max(AIDEN_LIMITS.bloomDuration.max);

export const AidenPulsesNumberSchema = z
  .number()
  .int()
  .min(AIDEN_LIMITS.pulsesNumber.min)
  .max(AIDEN_LIMITS.pulsesNumber.max);

export const AidenPulsesIntervalSchema = z
  .number()
  .int()
  .min(AIDEN_LIMITS.pulsesInterval.min)
  .max(AIDEN_LIMITS.pulsesInterval.max);

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
  .strictObject({
    /**
     * The reference client's model declares `profileType: int` with no validator, and every usage
     * of it there — the README example, brew_studio, brew_assistant — sends 0. Nothing documents
     * what another value means, so 0 is the only value this server will write to a brewer
     * (aiden-recipe-generator-iaf).
     */
    profileType: z.literal(0).default(0),
    title: AidenTitleSchema,
    overallTemperature: AidenTemperatureSchema.optional().nullable(),
    ratio: AidenRatioSchema,
    bloomEnabled: z.boolean(),
    bloomRatio: AidenBloomRatioSchema,
    bloomDuration: AidenBloomDurationSchema,
    bloomTemperature: AidenTemperatureSchema,
    ssPulsesEnabled: z.boolean(),
    ssPulsesNumber: AidenPulsesNumberSchema,
    ssPulsesInterval: AidenPulsesIntervalSchema,
    ssPulseTemperatures: AidenPulseTemperaturesSchema.default([]),
    batchPulsesEnabled: z.boolean(),
    batchPulsesNumber: AidenPulsesNumberSchema,
    batchPulsesInterval: AidenPulsesIntervalSchema.default(30),
    batchPulseTemperatures: AidenPulseTemperaturesSchema.default([])
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

/** Schema for updating an existing profile: every field optional, but at least one required */
export const AidenUpdateProfileSchema = z
  .strictObject({
    // profileType and duration are absent on purpose: the first is fixed at creation (see the
    // create schema) and the second is server-derived. A patch naming either is rejected rather
    // than silently stripped, so a model sending one hears about it.
    title: AidenTitleSchema.optional(),
    ratio: AidenRatioSchema.optional(),
    bloomEnabled: z.boolean().optional(),
    overallTemperature: AidenTemperatureSchema.optional().nullable(),
    bloomRatio: AidenBloomRatioSchema.optional(),
    bloomDuration: AidenBloomDurationSchema.optional(),
    bloomTemperature: AidenTemperatureSchema.optional(),
    ssPulsesEnabled: z.boolean().optional(),
    ssPulsesNumber: AidenPulsesNumberSchema.optional(),
    ssPulsesInterval: AidenPulsesIntervalSchema.optional(),
    ssPulseTemperatures: AidenPulseTemperaturesSchema.nullable().optional(),
    batchPulsesEnabled: z.boolean().optional(),
    batchPulsesNumber: AidenPulsesNumberSchema.optional(),
    batchPulsesInterval: AidenPulsesIntervalSchema.nullable().optional(),
    batchPulseTemperatures: AidenPulseTemperaturesSchema.nullable().optional()
  })
  .superRefine((patch, ctx) => {
    // Every field is optional, so {} parses. Letting it through spends an authenticated write on
    // the brewer and answers ok:true, which tells a model its no-op patch worked. A null is a real
    // change (it clears the field), so only absent values count as nothing to do.
    if (Object.values(patch).every((value) => value === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An update needs at least one field to change.'
      });
    }

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
