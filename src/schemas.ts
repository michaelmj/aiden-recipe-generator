/**
 * Zod schemas for Aiden profile API payloads.
 * Used for validation and type inference.
 */

import * as z from 'zod/v4';

/** Schema for creating a new brew profile */
export const AidenCreateProfileSchema = z.object({
  profileType: z.number().int().min(0).max(10).default(0),
  title: z.string().min(1),
  overallTemperature: z.number().optional().nullable(),
  ratio: z.number().positive(),
  bloomEnabled: z.boolean(),
  bloomRatio: z.number().positive(),
  bloomDuration: z.number().int().nonnegative(),
  bloomTemperature: z.number().positive(),
  ssPulsesEnabled: z.boolean(),
  ssPulsesNumber: z.number().int().nonnegative(),
  ssPulsesInterval: z.number().int().nonnegative(),
  ssPulseTemperatures: z.array(z.number()).default([]),
  batchPulsesEnabled: z.boolean(),
  batchPulsesNumber: z.number().int().nonnegative(),
  batchPulsesInterval: z.number().int().nonnegative().default(30),
  batchPulseTemperatures: z.array(z.number()).default([])
});

export type AidenCreateProfileInput = z.infer<typeof AidenCreateProfileSchema>;

/** Schema for updating an existing profile (all fields optional) */
export const AidenUpdateProfileSchema = z.object({
  profileType: z.number().int().min(0).max(10).optional(),
  title: z.string().min(1).optional(),
  ratio: z.number().positive().optional(),
  duration: z.number().optional(),
  bloomEnabled: z.boolean().optional(),
  overallTemperature: z.number().optional().nullable(),
  bloomRatio: z.number().positive().optional(),
  bloomDuration: z.number().int().nonnegative().optional(),
  bloomTemperature: z.number().positive().optional(),
  ssPulsesEnabled: z.boolean().optional(),
  ssPulsesNumber: z.number().int().nonnegative().optional(),
  ssPulsesInterval: z.number().int().nonnegative().optional(),
  ssPulseTemperatures: z.array(z.number()).nullable().optional(),
  batchPulsesEnabled: z.boolean().optional(),
  batchPulsesNumber: z.number().int().nonnegative().optional(),
  batchPulsesInterval: z.number().int().nonnegative().nullable().optional(),
  batchPulseTemperatures: z.array(z.number()).nullable().optional()
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
