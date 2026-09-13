/**
 * Sanitizer for community sheet cells.
 *
 * Cells are written by strangers, so nothing that comes out of the CSV is trusted shape or size.
 * Every cell goes through the shared text neutralizer in @/text and — for brewing fields — a range
 * check. A field that fails is dropped rather than passed through as junk; a row
 * that loses its title is dropped whole.
 */

import * as z from 'zod/v4';
import type { SheetProfile } from '@/sheet/store';
import { sanitizeText, TITLE_MAX_CHARS } from '@/text';

/** Most temperatures kept from a comma-separated pulse-temp list. */
const MAX_PULSE_TEMPS = 20;

/** A bounded number written as a string; returns the canonical form or undefined if out of range. */
function boundedNumber(value: string, min: number, max: number, integer = false): string | undefined {
  const schema = z.coerce
    .number()
    .refine((n) => Number.isFinite(n))
    .refine((n) => !integer || Number.isInteger(n))
    .refine((n) => n >= min && n <= max);

  const parsed = schema.safeParse(stripWrappingQuotes(value));
  return parsed.success ? String(parsed.data) : undefined;
}

/** Sheet authors sometimes wrap values in stray quotes ('90,89'); drop them before parsing. */
function stripWrappingQuotes(value: string): string {
  return value.replace(/^["']+/, '').replace(/["']+$/, '');
}

/** A comma-separated temperature list, each entry range-checked; undefined if none survive. */
function temperatureList(value: string): string | undefined {
  const temps = stripWrappingQuotes(value)
    .split(',')
    .map((part) => boundedNumber(part, 0, 100))
    .filter((part): part is string => part !== undefined)
    .slice(0, MAX_PULSE_TEMPS);

  return temps.length > 0 ? temps.join(',') : undefined;
}

type FieldRule = (value: string) => string | undefined;

/**
 * Per-field validation. Ranges are what an Aiden can physically do, so anything outside them is
 * sheet noise or an attempt to steer a later profile write.
 */
const FIELD_RULES: Record<keyof Omit<SheetProfile, 'title'>, FieldRule> = {
  origin: (v) => sanitizeText(v) || undefined,
  roast: (v) => sanitizeText(v) || undefined,
  processing: (v) => sanitizeText(v) || undefined,
  varietal: (v) => sanitizeText(v) || undefined,
  brewRatio: (v) => boundedNumber(v, 1, 30),
  bloomRatio: (v) => boundedNumber(v, 0, 30),
  bloomTime: (v) => boundedNumber(v, 0, 600),
  bloomTemp: (v) => boundedNumber(v, 0, 100),
  ssPulsesNumber: (v) => boundedNumber(v, 0, 20, true),
  ssPulsesInterval: (v) => boundedNumber(v, 0, 600),
  ssPulseTemps: temperatureList,
  batchPulsesNumber: (v) => boundedNumber(v, 0, 20, true),
  batchPulsesInterval: (v) => boundedNumber(v, 0, 600),
  batchPulseTemps: temperatureList
};

/** Sanitize one field; returns undefined when the value fails its rule and should be dropped. */
export function sanitizeField(field: keyof SheetProfile, value: string): string | undefined {
  if (field === 'title') return sanitizeText(value, TITLE_MAX_CHARS) || undefined;
  return FIELD_RULES[field](value);
}

/**
 * Sanitize a whole parsed row. Returns null when the title does not survive, since a titleless
 * recipe is not usable and keeping it would just feed the model anonymous attacker text.
 */
export function sanitizeProfile(raw: Record<string, string>): SheetProfile | null {
  const title = sanitizeField('title', raw.title ?? '');
  if (!title) return null;

  const profile: SheetProfile = { title };
  for (const field of Object.keys(FIELD_RULES) as (keyof Omit<SheetProfile, 'title'>)[]) {
    const value = raw[field];
    if (value === undefined) continue;
    const clean = sanitizeField(field, value);
    if (clean !== undefined) profile[field] = clean;
  }
  return profile;
}
