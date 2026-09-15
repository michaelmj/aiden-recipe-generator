/**
 * Validation for recipe-source cells.
 *
 * Source values stay as strings for compatibility with the community sheet, but every brewing
 * value is parsed by the same exported schemas used by the Fellow write contract. Invalid values
 * are removed and reported; missing values remain distinguishable from invalid ones.
 */

import type * as z from 'zod/v4';
import {
  AIDEN_LIMITS,
  AidenBloomDurationSchema,
  AidenBloomRatioSchema,
  type AidenCreateProfileInput,
  AidenCreateProfileSchema,
  AidenPulsesIntervalSchema,
  AidenPulsesNumberSchema,
  AidenRatioSchema,
  AidenTemperatureSchema,
  AidenTitleSchema
} from '@/schemas';
import type { SheetProfile } from '@/sheet/store';
import { sanitizeText, TITLE_MAX_CHARS } from '@/text';

type BrewingField = Exclude<keyof SheetProfile, 'title' | 'origin' | 'roast' | 'processing' | 'varietal'>;

export type SourceProfileIssue = {
  field: keyof SheetProfile;
  code: 'invalid' | 'conflict';
  message: string;
};

export type SourceProfileValidation = {
  status: 'complete' | 'incomplete' | 'invalid';
  missingFields: BrewingField[];
  issues: SourceProfileIssue[];
};

export type SanitizedSheetProfile = SheetProfile & { validation: SourceProfileValidation };

type FieldResult = { value?: string; issue?: string };
type FieldRule = (value: string) => FieldResult;

/** Fields needed to deterministically form a complete create-profile payload. */
const REQUIRED_SOURCE_FIELDS: BrewingField[] = [
  'brewRatio',
  'bloomRatio',
  'bloomTime',
  'bloomTemp',
  'ssPulsesNumber',
  'ssPulsesInterval',
  'ssPulseTemps',
  'batchPulsesNumber',
  'batchPulseTemps'
];

/** Sheet authors sometimes wrap values in stray quotes ('90,89'); drop them before parsing. */
function stripWrappingQuotes(value: string): string {
  return value.replace(/^["']+/, '').replace(/["']+$/, '');
}

/** Parse a source number through one canonical write-field schema. */
function canonicalNumber(schema: z.ZodType<number>): FieldRule {
  return (value) => {
    const candidate = Number(stripWrappingQuotes(value).trim());
    const parsed = schema.safeParse(candidate);
    return parsed.success
      ? { value: String(parsed.data) }
      : { issue: 'Value does not satisfy the canonical Aiden range, integer, or step constraint.' };
  };
}

/** Parse a temperature list without hiding invalid entries or count overflow. */
function temperatureList(value: string): FieldResult {
  const parts = stripWrappingQuotes(value).split(',');
  const valid: string[] = [];
  let invalid = parts.length > AIDEN_LIMITS.pulsesNumber.max;

  for (const part of parts.slice(0, AIDEN_LIMITS.pulsesNumber.max)) {
    const parsed = AidenTemperatureSchema.safeParse(Number(part.trim()));
    if (parsed.success) valid.push(String(parsed.data));
    else invalid = true;
  }

  return {
    ...(valid.length > 0 ? { value: valid.join(',') } : {}),
    ...(invalid ? { issue: 'Temperature list contains an invalid entry or exceeds the pulse limit.' } : {})
  };
}

const FIELD_RULES: Record<keyof Omit<SheetProfile, 'title'>, FieldRule> = {
  origin: (value) => ({ value: sanitizeText(value) || undefined }),
  roast: (value) => ({ value: sanitizeText(value) || undefined }),
  processing: (value) => ({ value: sanitizeText(value) || undefined }),
  varietal: (value) => ({ value: sanitizeText(value) || undefined }),
  brewRatio: canonicalNumber(AidenRatioSchema),
  bloomRatio: canonicalNumber(AidenBloomRatioSchema),
  bloomTime: canonicalNumber(AidenBloomDurationSchema),
  bloomTemp: canonicalNumber(AidenTemperatureSchema),
  ssPulsesNumber: canonicalNumber(AidenPulsesNumberSchema),
  ssPulsesInterval: canonicalNumber(AidenPulsesIntervalSchema),
  ssPulseTemps: temperatureList,
  batchPulsesNumber: canonicalNumber(AidenPulsesNumberSchema),
  batchPulsesInterval: canonicalNumber(AidenPulsesIntervalSchema),
  batchPulseTemps: temperatureList
};

/** Sanitize one field. Use sanitizeProfile when validation issues must be retained. */
export function sanitizeField(field: keyof SheetProfile, value: string): string | undefined {
  if (field === 'title') return sanitizeText(value, TITLE_MAX_CHARS) || undefined;
  return FIELD_RULES[field](value).value;
}

function addCountConflict(
  profile: SheetProfile,
  issues: SourceProfileIssue[],
  countField: 'ssPulsesNumber' | 'batchPulsesNumber',
  temperaturesField: 'ssPulseTemps' | 'batchPulseTemps'
): void {
  const count = Number(profile[countField]);
  const temperatures = profile[temperaturesField]?.split(',') ?? [];
  if (!Number.isFinite(count) || temperatures.length <= count) return;

  issues.push({
    field: temperaturesField,
    code: 'conflict',
    message: `${temperaturesField} has ${temperatures.length} entries but ${countField} is ${count}.`
  });
  delete profile[temperaturesField];
}

/**
 * Sanitize one source record and classify it as complete, incomplete, or invalid.
 * A title that cannot be shown on the brewer rejects the whole anonymous record.
 */
export function sanitizeProfile(raw: Record<string, string>): SanitizedSheetProfile | null {
  const title = sanitizeField('title', raw.title ?? '');
  if (!title) return null;

  const profile: SheetProfile = { title };
  const issues: SourceProfileIssue[] = [];
  if (!AidenTitleSchema.safeParse(title).success) {
    issues.push({
      field: 'title',
      code: 'invalid',
      message: 'Title does not satisfy the canonical Aiden length or character constraint.'
    });
  }
  for (const field of Object.keys(FIELD_RULES) as (keyof Omit<SheetProfile, 'title'>)[]) {
    const value = raw[field];
    if (value === undefined) continue;

    const result = FIELD_RULES[field](value);
    if (result.value !== undefined) profile[field] = result.value;
    if (result.issue) issues.push({ field, code: 'invalid', message: result.issue });
  }

  addCountConflict(profile, issues, 'ssPulsesNumber', 'ssPulseTemps');
  addCountConflict(profile, issues, 'batchPulsesNumber', 'batchPulseTemps');

  const missingFields = REQUIRED_SOURCE_FIELDS.filter((field) => profile[field] === undefined);
  const status = issues.length > 0 ? 'invalid' : missingFields.length > 0 ? 'incomplete' : 'complete';
  return { ...profile, validation: { status, missingFields, issues } };
}

export type ProfileConversionResult =
  | { success: true; profile: AidenCreateProfileInput }
  | { success: false; status: 'incomplete' | 'invalid'; missingFields: BrewingField[]; issues: SourceProfileIssue[] };

/** Convert a complete source recipe into the exact bounded Fellow create payload. */
export function toAidenCreateProfile(profile: SanitizedSheetProfile): ProfileConversionResult {
  if (profile.validation.status !== 'complete') {
    return {
      success: false,
      status: profile.validation.status,
      missingFields: profile.validation.missingFields,
      issues: profile.validation.issues
    };
  }

  const parsed = AidenCreateProfileSchema.safeParse({
    title: profile.title,
    ratio: Number(profile.brewRatio),
    bloomEnabled: true,
    bloomRatio: Number(profile.bloomRatio),
    bloomDuration: Number(profile.bloomTime),
    bloomTemperature: Number(profile.bloomTemp),
    ssPulsesEnabled: true,
    ssPulsesNumber: Number(profile.ssPulsesNumber),
    ssPulsesInterval: Number(profile.ssPulsesInterval),
    ssPulseTemperatures: profile.ssPulseTemps?.split(',').map(Number),
    batchPulsesEnabled: true,
    batchPulsesNumber: Number(profile.batchPulsesNumber),
    ...(profile.batchPulsesInterval ? { batchPulsesInterval: Number(profile.batchPulsesInterval) } : {}),
    batchPulseTemperatures: profile.batchPulseTemps?.split(',').map(Number)
  });

  if (parsed.success) return { success: true, profile: parsed.data };

  return {
    success: false,
    status: 'invalid',
    missingFields: [],
    issues: parsed.error.issues.map((issue) => ({
      field: String(issue.path[0] ?? 'title') as keyof SheetProfile,
      code: 'invalid',
      message: issue.message
    }))
  };
}
