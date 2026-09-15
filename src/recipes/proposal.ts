/**
 * Pure, versioned recipe-proposal contract and deterministic evidence ranking.
 *
 * This module has no MCP or Fellow client dependency. A proposal is reviewable data, never an
 * authorization to write it to a brewer.
 */

import * as z from 'zod/v4';
import type { Recipe } from '@/recipes/dataset';
import {
  AidenBloomDurationSchema,
  AidenBloomRatioSchema,
  AidenCreateProfileSchema,
  AidenPulsesIntervalSchema,
  AidenPulsesNumberSchema,
  AidenPulseTemperaturesSchema,
  AidenRatioSchema,
  AidenTemperatureSchema
} from '@/schemas';
import { toAidenCreateProfile } from '@/sheet/sanitize';
import type { BrewEntry } from '@/storage/brewLog';

const IdentityTextSchema = z.string().trim().min(1).max(200);

export const RoastLevelSchema = z.enum(['light', 'medium-light', 'medium', 'medium-dark', 'dark', 'unknown']);

export const CoffeeIdentitySchema = z.strictObject({
  name: IdentityTextSchema,
  roaster: IdentityTextSchema.optional(),
  origin: IdentityTextSchema.optional(),
  roastLevel: RoastLevelSchema,
  processing: IdentityTextSchema.optional(),
  varietal: IdentityTextSchema.optional()
});
export type CoffeeIdentity = z.infer<typeof CoffeeIdentitySchema>;

export const BrewTargetSchema = z
  .strictObject({
    mode: z.enum(['single-serve', 'batch']),
    volumeMl: z.number().int().min(150).max(1_500)
  })
  .superRefine((target, ctx) => {
    if (target.mode === 'single-serve' && target.volumeMl > 450) {
      ctx.addIssue({ code: 'custom', path: ['volumeMl'], message: 'Single-serve volume cannot exceed 450 ml.' });
    }
    if (target.mode === 'batch' && target.volumeMl <= 450) {
      ctx.addIssue({ code: 'custom', path: ['volumeMl'], message: 'Batch volume must exceed 450 ml.' });
    }
  });
export type BrewTarget = z.infer<typeof BrewTargetSchema>;

export const EvidenceKindSchema = z.enum([
  'first-party-history',
  'bundled-first-party',
  'roaster-guidance',
  'bundled-roaster',
  'reviewed-community-snapshot',
  'live-community-sheet',
  'web-review'
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceTrustTierSchema = z.enum([
  'first-party',
  'attributed',
  'reviewed-community',
  'untrusted-third-party'
]);
export type EvidenceTrustTier = z.infer<typeof EvidenceTrustTierSchema>;

export const EVIDENCE_TRUST_TIER: Record<EvidenceKind, EvidenceTrustTier> = {
  'first-party-history': 'first-party',
  'bundled-first-party': 'first-party',
  'roaster-guidance': 'attributed',
  'bundled-roaster': 'attributed',
  'reviewed-community-snapshot': 'reviewed-community',
  'live-community-sheet': 'untrusted-third-party',
  'web-review': 'untrusted-third-party'
};

/** Integer weights keep ranking stable across runtimes and easy to audit. */
export const EVIDENCE_RANKING_WEIGHTS = {
  trust: {
    'first-party-history': 120,
    'bundled-first-party': 105,
    'roaster-guidance': 85,
    'bundled-roaster': 80,
    'reviewed-community-snapshot': 60,
    'web-review': 40,
    'live-community-sheet': 30
  },
  similarity: {
    name: 30,
    roaster: 20,
    origin: 18,
    processing: 16,
    roastLevel: 12,
    varietal: 8,
    mode: 6,
    volume: 6
  },
  rating: { 1: -30, 2: -15, 3: 0, 4: 20, 5: 30 }
} as const;

const EvidenceOutcomeSchema = z.strictObject({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  notes: z.string().trim().min(1).max(2_000).optional()
});

/** Canonically validated parameters a source actually states, without pretending it is a full profile. */
export const EvidenceSourceParametersSchema = z
  .strictObject({
    overallTemperature: AidenTemperatureSchema.nullable().optional(),
    ratio: AidenRatioSchema.optional(),
    bloomEnabled: z.boolean().optional(),
    bloomRatio: AidenBloomRatioSchema.optional(),
    bloomDuration: AidenBloomDurationSchema.optional(),
    bloomTemperature: AidenTemperatureSchema.optional(),
    ssPulsesEnabled: z.boolean().optional(),
    ssPulsesNumber: AidenPulsesNumberSchema.optional(),
    ssPulsesInterval: AidenPulsesIntervalSchema.optional(),
    ssPulseTemperatures: AidenPulseTemperaturesSchema.optional(),
    batchPulsesEnabled: z.boolean().optional(),
    batchPulsesNumber: AidenPulsesNumberSchema.optional(),
    batchPulsesInterval: AidenPulsesIntervalSchema.nullable().optional(),
    batchPulseTemperatures: AidenPulseTemperaturesSchema.optional()
  })
  .superRefine((parameters, ctx) => {
    const pairs = [
      ['ssPulseTemperatures', 'ssPulsesNumber'],
      ['batchPulseTemperatures', 'batchPulsesNumber']
    ] as const;
    for (const [temperaturesField, countField] of pairs) {
      const temperatures = parameters[temperaturesField];
      const count = parameters[countField];
      if (temperatures && count !== undefined && temperatures.length > count) {
        ctx.addIssue({
          code: 'custom',
          path: [temperaturesField],
          message: `${temperaturesField} has ${temperatures.length} entries but only ${count} pulses are stated.`
        });
      }
    }
    if (Object.values(parameters).every((value) => value === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Source parameters must state at least one value.' });
    }
  });
export type EvidenceSourceParameters = z.infer<typeof EvidenceSourceParametersSchema>;

const EvidenceProvenanceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('brew-log'), brewId: z.string().min(1).max(128) }),
  z.strictObject({
    type: z.literal('bundled-recipe'),
    recipeId: z.string().min(1).max(128),
    datasetVersion: z.literal(1)
  }),
  z.strictObject({
    type: z.literal('url'),
    url: z.url().max(1_000),
    retrievedAt: z.iso.datetime({ offset: true })
  }),
  z.strictObject({
    type: z.literal('live-sheet'),
    url: z.url().max(1_000),
    rowRef: z.string().min(1).max(200),
    retrievedAt: z.iso.datetime({ offset: true })
  })
]);

const EXPECTED_PROVENANCE: Record<EvidenceKind, z.infer<typeof EvidenceProvenanceSchema>['type']> = {
  'first-party-history': 'brew-log',
  'bundled-first-party': 'bundled-recipe',
  'roaster-guidance': 'url',
  'bundled-roaster': 'bundled-recipe',
  'reviewed-community-snapshot': 'bundled-recipe',
  'live-community-sheet': 'live-sheet',
  'web-review': 'url'
};

export const EvidenceCandidateSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    kind: EvidenceKindSchema,
    verification: z.enum(['authoritative', 'external-claim']),
    title: z.string().trim().min(1).max(300),
    provenance: EvidenceProvenanceSchema,
    observedAt: z.iso.datetime({ offset: true }).optional(),
    coffee: CoffeeIdentitySchema.optional(),
    target: BrewTargetSchema.optional(),
    profile: AidenCreateProfileSchema.optional(),
    sourceParameters: EvidenceSourceParametersSchema.optional(),
    observations: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
    sourceWarnings: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
    outcome: EvidenceOutcomeSchema.optional()
  })
  .superRefine((evidence, ctx) => {
    if (evidence.provenance.type !== EXPECTED_PROVENANCE[evidence.kind]) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: `${evidence.kind} must use ${EXPECTED_PROVENANCE[evidence.kind]} provenance.`
      });
    }
    const authoritative = [
      'first-party-history',
      'bundled-first-party',
      'bundled-roaster',
      'reviewed-community-snapshot'
    ].includes(evidence.kind);
    if (evidence.verification !== (authoritative ? 'authoritative' : 'external-claim')) {
      ctx.addIssue({
        code: 'custom',
        path: ['verification'],
        message: `${evidence.kind} must use ${authoritative ? 'authoritative' : 'external-claim'} verification.`
      });
    }
    if (evidence.kind === 'first-party-history' && !evidence.outcome) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'First-party history needs a tasted rating before it receives first-party-history rank.'
      });
    }
    if (evidence.profile && evidence.sourceParameters) {
      for (const parameter of Object.keys(evidence.sourceParameters) as (keyof EvidenceSourceParameters)[]) {
        if (JSON.stringify(evidence.profile[parameter]) !== JSON.stringify(evidence.sourceParameters[parameter])) {
          ctx.addIssue({
            code: 'custom',
            path: ['sourceParameters', parameter],
            message: `Source parameter ${parameter} conflicts with the complete source profile.`
          });
        }
      }
    }
  });
export type EvidenceCandidate = z.input<typeof EvidenceCandidateSchema>;
type ValidatedEvidenceCandidate = z.output<typeof EvidenceCandidateSchema>;
const VERIFIED_EVIDENCE = Symbol('verified-evidence');
export type VerifiedEvidenceCandidate = ValidatedEvidenceCandidate & { readonly [VERIFIED_EVIDENCE]: true };

function stampEvidence(candidate: EvidenceCandidate): VerifiedEvidenceCandidate {
  const parsed = EvidenceCandidateSchema.parse(candidate) as VerifiedEvidenceCandidate;
  Object.defineProperty(parsed, VERIFIED_EVIDENCE, { value: true, enumerable: false });
  return parsed;
}

function roastLevel(value: string | undefined): CoffeeIdentity['roastLevel'] {
  const roast = normalized(value);
  if (roast.includes('medium light') || roast.includes('light medium')) return 'medium-light';
  if (roast.includes('medium dark') || roast.includes('dark medium')) return 'medium-dark';
  if (roast.includes('light')) return 'light';
  if (roast.includes('dark')) return 'dark';
  if (roast.includes('medium')) return 'medium';
  return 'unknown';
}

/** Construct highest-trust evidence only from values in a tasted local brew-log entry. */
export function evidenceFromBrewHistory(entry: BrewEntry): VerifiedEvidenceCandidate {
  if (!entry.feedback) throw new Error('First-party history needs saved tasting feedback.');
  const observations = [
    entry.feedback.taste,
    entry.feedback.notes,
    `Operator rating: ${entry.feedback.rating}/5.`
  ].filter((value): value is string => Boolean(value));
  return stampEvidence({
    id: `history:${entry.id}`,
    kind: 'first-party-history',
    verification: 'authoritative',
    title: `Tasted brew: ${entry.coffee.name}`,
    provenance: { type: 'brew-log', brewId: entry.id },
    coffee: {
      name: entry.coffee.name,
      ...(entry.coffee.roaster ? { roaster: entry.coffee.roaster } : {}),
      ...(entry.coffee.origin ? { origin: entry.coffee.origin } : {}),
      roastLevel: roastLevel(entry.coffee.roast),
      ...(entry.coffee.processing ? { processing: entry.coffee.processing } : {})
    },
    sourceParameters: {
      ratio: entry.profile.ratio,
      bloomDuration: entry.profile.bloomDuration,
      bloomTemperature: entry.profile.bloomTemp
    },
    observations,
    outcome: { rating: entry.feedback.rating, ...(entry.feedback.notes ? { notes: entry.feedback.notes } : {}) }
  });
}

/** Construct reviewed bundled evidence, deriving kind from dataset provenance. */
export function evidenceFromBundledRecipe(recipe: Recipe): VerifiedEvidenceCandidate {
  const kind = {
    'first-party': 'bundled-first-party',
    roaster: 'bundled-roaster',
    'community-sheet': 'reviewed-community-snapshot'
  }[recipe.source.kind] as Extract<EvidenceKind, `bundled-${string}` | 'reviewed-community-snapshot'>;
  const converted = toAidenCreateProfile(recipe);
  const rawSourceParameters = {
    ...(recipe.brewRatio ? { ratio: Number(recipe.brewRatio) } : {}),
    ...(recipe.bloomRatio ? { bloomRatio: Number(recipe.bloomRatio) } : {}),
    ...(recipe.bloomTime ? { bloomDuration: Number(recipe.bloomTime) } : {}),
    ...(recipe.bloomTemp ? { bloomTemperature: Number(recipe.bloomTemp) } : {}),
    ...(recipe.ssPulsesNumber ? { ssPulsesNumber: Number(recipe.ssPulsesNumber) } : {}),
    ...(recipe.ssPulsesInterval ? { ssPulsesInterval: Number(recipe.ssPulsesInterval) } : {}),
    ...(recipe.ssPulseTemps ? { ssPulseTemperatures: recipe.ssPulseTemps.split(',').map(Number) } : {}),
    ...(recipe.batchPulsesNumber ? { batchPulsesNumber: Number(recipe.batchPulsesNumber) } : {}),
    ...(recipe.batchPulsesInterval ? { batchPulsesInterval: Number(recipe.batchPulsesInterval) } : {}),
    ...(recipe.batchPulseTemps ? { batchPulseTemperatures: recipe.batchPulseTemps.split(',').map(Number) } : {})
  };
  const parsedSourceParameters = EvidenceSourceParametersSchema.safeParse(rawSourceParameters);
  const sourceParameters = parsedSourceParameters.success ? parsedSourceParameters.data : undefined;
  const sourceWarnings = recipe.validation.issues.map((issue) => `${issue.field}: ${issue.message}`);
  if (!parsedSourceParameters.success && Object.keys(rawSourceParameters).length > 0) {
    sourceWarnings.push(
      ...parsedSourceParameters.error.issues.map(
        (issue) =>
          `Source parameter validation failed${issue.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue.message}`
      )
    );
  }
  if (!converted.success) {
    sourceWarnings.push(`Profile conversion failed: source is ${converted.status}.`);
    sourceWarnings.push(...converted.missingFields.map((field) => `Missing required source field: ${field}.`));
    sourceWarnings.push(...converted.issues.map((issue) => `${issue.field}: ${issue.message}`));
  }
  return stampEvidence({
    id: `bundled:${recipe.id}`,
    kind,
    verification: 'authoritative',
    title: recipe.title,
    provenance: { type: 'bundled-recipe', recipeId: recipe.id, datasetVersion: 1 },
    coffee: {
      name: recipe.title,
      ...(recipe.origin ? { origin: recipe.origin } : {}),
      roastLevel: roastLevel(recipe.roast),
      ...(recipe.processing ? { processing: recipe.processing } : {}),
      ...(recipe.varietal ? { varietal: recipe.varietal } : {})
    },
    ...(sourceParameters ? { sourceParameters } : {}),
    ...(converted.success ? { profile: converted.profile } : {}),
    observations: [recipe.notes ?? `Reviewed bundled recipe ${recipe.id}.`],
    sourceWarnings: [...new Set(sourceWarnings)]
  });
}

/** Admit attributable external claims without allowing them to self-promote to local trust. */
export function evidenceFromExternalClaim(
  candidate: Omit<EvidenceCandidate, 'verification' | 'kind'> & {
    kind: 'roaster-guidance' | 'live-community-sheet' | 'web-review';
  }
): VerifiedEvidenceCandidate {
  return stampEvidence({ ...candidate, verification: 'external-claim' });
}

const RankingSchema = z.strictObject({
  position: z.number().int().positive(),
  trustScore: z.number().int(),
  similarityScore: z.number().int().nonnegative(),
  outcomeScore: z.number().int(),
  totalScore: z.number().int(),
  matchedFields: z.array(
    z.enum(['name', 'roaster', 'origin', 'processing', 'roastLevel', 'varietal', 'mode', 'volume'])
  )
});

export const RankedEvidenceSchema = EvidenceCandidateSchema.extend({
  trustTier: EvidenceTrustTierSchema,
  ranking: RankingSchema
}).superRefine((evidence, ctx) => {
  if (evidence.trustTier !== EVIDENCE_TRUST_TIER[evidence.kind]) {
    ctx.addIssue({
      code: 'custom',
      path: ['trustTier'],
      message: `${evidence.kind} must use derived trust tier ${EVIDENCE_TRUST_TIER[evidence.kind]}.`
    });
  }
});
export type RankedEvidence = z.infer<typeof RankedEvidenceSchema>;

function normalized(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function same(left: string | undefined, right: string | undefined): boolean {
  const a = normalized(left);
  return a.length > 0 && a === normalized(right);
}

function related(left: string | undefined, right: string | undefined): boolean {
  const tokens = (value: string | undefined) =>
    normalized(value)
      .split(' ')
      .filter((token) => token.length >= 3);
  const a = tokens(left);
  const b = new Set(tokens(right));
  return a.length > 0 && b.size > 0 && a.some((token) => b.has(token));
}

function scoreCandidate(coffee: CoffeeIdentity, target: BrewTarget, evidence: ValidatedEvidenceCandidate) {
  const matchedFields: z.infer<typeof RankingSchema>['matchedFields'] = [];
  let similarityScore = 0;
  const compare = (
    field: 'name' | 'roaster' | 'origin' | 'processing' | 'roastLevel' | 'varietal',
    left: string | undefined,
    right: string | undefined,
    matches = same
  ) => {
    if (!matches(left, right)) return;
    similarityScore += EVIDENCE_RANKING_WEIGHTS.similarity[field];
    matchedFields.push(field);
  };

  compare('name', coffee.name, evidence.coffee?.name);
  compare('roaster', coffee.roaster, evidence.coffee?.roaster);
  compare('origin', coffee.origin, evidence.coffee?.origin, related);
  compare('processing', coffee.processing, evidence.coffee?.processing, related);
  compare('roastLevel', coffee.roastLevel, evidence.coffee?.roastLevel);
  compare('varietal', coffee.varietal, evidence.coffee?.varietal, related);

  if (evidence.target?.mode === target.mode) {
    similarityScore += EVIDENCE_RANKING_WEIGHTS.similarity.mode;
    matchedFields.push('mode');
  }
  if (evidence.target && Math.abs(evidence.target.volumeMl - target.volumeMl) <= 50) {
    similarityScore += EVIDENCE_RANKING_WEIGHTS.similarity.volume;
    matchedFields.push('volume');
  }

  const trustScore = EVIDENCE_RANKING_WEIGHTS.trust[evidence.kind];
  const outcomeScore = evidence.outcome ? EVIDENCE_RANKING_WEIGHTS.rating[evidence.outcome.rating] : 0;
  return {
    trustScore,
    similarityScore,
    outcomeScore,
    totalScore: trustScore + similarityScore + outcomeScore,
    matchedFields
  };
}

/**
 * Rank evidence by total, then trust, similarity, outcome, and stable id. Input order never breaks
 * ties. Successful relevant first-party brews receive both the highest trust and a rating bonus.
 */
export function rankEvidence(
  coffeeInput: CoffeeIdentity,
  targetInput: BrewTarget,
  candidatesInput: VerifiedEvidenceCandidate[]
): RankedEvidence[] {
  const coffee = CoffeeIdentitySchema.parse(coffeeInput);
  const target = BrewTargetSchema.parse(targetInput);
  const candidates = z.array(EvidenceCandidateSchema).parse(candidatesInput);
  if (candidatesInput.some((candidate) => candidate[VERIFIED_EVIDENCE] !== true)) {
    throw new Error('Evidence must come from an authoritative or external evidence adapter.');
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('Evidence candidate ids must be unique before ranking.');
  }
  return rankValidatedEvidence(coffee, target, candidates);
}

function rankValidatedEvidence(
  coffee: CoffeeIdentity,
  target: BrewTarget,
  candidates: ValidatedEvidenceCandidate[]
): RankedEvidence[] {
  const scored = candidates.map((evidence) => ({ evidence, score: scoreCandidate(coffee, target, evidence) }));

  scored.sort(
    (a, b) =>
      b.score.totalScore - a.score.totalScore ||
      b.score.trustScore - a.score.trustScore ||
      b.score.similarityScore - a.score.similarityScore ||
      b.score.outcomeScore - a.score.outcomeScore ||
      (a.evidence.id < b.evidence.id ? -1 : a.evidence.id > b.evidence.id ? 1 : 0)
  );

  return scored.map(({ evidence, score }, index) =>
    RankedEvidenceSchema.parse({
      ...evidence,
      trustTier: EVIDENCE_TRUST_TIER[evidence.kind],
      ranking: { position: index + 1, ...score }
    })
  );
}

export const AIDEN_RATIONALE_PARAMETERS = [
  'overallTemperature',
  'ratio',
  'bloomEnabled',
  'bloomRatio',
  'bloomDuration',
  'bloomTemperature',
  'ssPulsesEnabled',
  'ssPulsesNumber',
  'ssPulsesInterval',
  'ssPulseTemperatures',
  'batchPulsesEnabled',
  'batchPulsesNumber',
  'batchPulsesInterval',
  'batchPulseTemperatures'
] as const;

const ParameterNameSchema = z.enum(AIDEN_RATIONALE_PARAMETERS);
const ParameterValueSchema = z.union([z.number(), z.boolean(), z.null(), z.array(z.number())]);

function sourceParameter(
  evidence: RankedEvidence | undefined,
  parameter: (typeof AIDEN_RATIONALE_PARAMETERS)[number]
): { present: true; value: z.infer<typeof ParameterValueSchema> } | { present: false } {
  if (!evidence) return { present: false };
  if (evidence.sourceParameters && Object.hasOwn(evidence.sourceParameters, parameter)) {
    return { present: true, value: evidence.sourceParameters[parameter] as z.infer<typeof ParameterValueSchema> };
  }
  if (evidence.profile && Object.hasOwn(evidence.profile, parameter)) {
    const value = evidence.profile[parameter];
    if (value !== undefined) return { present: true, value };
  }
  return { present: false };
}

const ParameterRationaleSchema = z.strictObject({
  parameter: ParameterNameSchema,
  proposedValue: ParameterValueSchema,
  reason: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.string()).max(50),
  assumptionIds: z.array(z.string()).max(50).default([]),
  deltas: z
    .array(
      z.strictObject({
        evidenceId: z.string(),
        sourceValue: ParameterValueSchema,
        delta: z.number().optional(),
        explanation: z.string().trim().min(1).max(1_000)
      })
    )
    .max(50)
});

const AssumptionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  statement: z.string().trim().min(1).max(1_000),
  basis: z.string().trim().min(1).max(1_000),
  confidence: z.number().min(0).max(1),
  affectedParameters: z.array(ParameterNameSchema).min(1)
});

const EvidenceGapSchema = z.strictObject({
  field: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1_000),
  requiredForApply: z.boolean()
});

const EvidenceConflictSchema = z.strictObject({
  id: z.string().min(1).max(128),
  field: z.string().trim().min(1).max(200),
  evidenceIds: z.array(z.string()).min(2).max(20),
  summary: z.string().trim().min(1).max(1_000),
  resolution: z.string().trim().min(1).max(1_000)
});

export const RecipeProposalSchema = z
  .strictObject({
    version: z.literal(1),
    proposalId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    createdAt: z.iso.datetime({ offset: true }),
    evidenceVerification: z.literal('required-before-apply'),
    coffee: CoffeeIdentitySchema,
    target: BrewTargetSchema,
    profile: AidenCreateProfileSchema,
    evidence: z.array(RankedEvidenceSchema).min(1).max(100),
    assumptions: z.array(AssumptionSchema).max(100),
    evidenceGaps: z.array(EvidenceGapSchema).max(100),
    conflicts: z.array(EvidenceConflictSchema).max(100),
    parameterRationale: z.array(ParameterRationaleSchema).min(1).max(100),
    confidence: z.strictObject({
      overall: z.number().min(0).max(1),
      explanation: z.string().trim().min(1).max(2_000)
    })
  })
  .superRefine((proposal, ctx) => {
    const evidenceIds = new Set(proposal.evidence.map((item) => item.id));
    const evidenceById = new Map(proposal.evidence.map((item) => [item.id, item]));
    const assumptionIds = new Set(proposal.assumptions.map((item) => item.id));
    const conflictIds = new Set(proposal.conflicts.map((item) => item.id));
    const rationaleParameters = new Set(proposal.parameterRationale.map((item) => item.parameter));

    if (evidenceIds.size !== proposal.evidence.length) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Evidence ids must be unique.' });
    }
    if (assumptionIds.size !== proposal.assumptions.length) {
      ctx.addIssue({ code: 'custom', path: ['assumptions'], message: 'Assumption ids must be unique.' });
    }
    if (conflictIds.size !== proposal.conflicts.length) {
      ctx.addIssue({ code: 'custom', path: ['conflicts'], message: 'Conflict ids must be unique.' });
    }

    if (evidenceIds.size === proposal.evidence.length) {
      const expectedRanking = rankValidatedEvidence(
        proposal.coffee,
        proposal.target,
        proposal.evidence.map(({ ranking: _ranking, trustTier: _trustTier, ...candidate }) => candidate)
      );
      proposal.evidence.forEach((item, index) => {
        const expected = expectedRanking[index];
        if (!expected || item.id !== expected.id || JSON.stringify(item.ranking) !== JSON.stringify(expected.ranking)) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidence', index, 'ranking'],
            message: 'Evidence order and score breakdown must equal deterministic rankEvidence output.'
          });
        }
      });
    }

    for (const parameter of AIDEN_RATIONALE_PARAMETERS) {
      if (proposal.profile[parameter] !== undefined && !rationaleParameters.has(parameter)) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameterRationale'],
          message: `Missing rationale for ${parameter}.`
        });
      }
    }
    if (rationaleParameters.size !== proposal.parameterRationale.length) {
      ctx.addIssue({ code: 'custom', path: ['parameterRationale'], message: 'Parameter rationales must be unique.' });
    }

    proposal.parameterRationale.forEach((rationale, index) => {
      const actual = proposal.profile[rationale.parameter];
      if (JSON.stringify(actual) !== JSON.stringify(rationale.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameterRationale', index, 'proposedValue'],
          message: `Rationale value must match profile.${rationale.parameter}.`
        });
      }
      for (const id of [...rationale.evidenceIds, ...rationale.deltas.map((delta) => delta.evidenceId)]) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['parameterRationale', index], message: `Unknown evidence id: ${id}.` });
        }
      }
      for (const id of rationale.assumptionIds) {
        if (!assumptionIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index],
            message: `Unknown assumption id: ${id}.`
          });
        }
      }

      const citedIds = new Set(rationale.evidenceIds);
      const deltaIds = new Set(rationale.deltas.map((delta) => delta.evidenceId));
      if (deltaIds.size !== rationale.deltas.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameterRationale', index, 'deltas'],
          message: 'Each evidence source can have at most one parameter delta.'
        });
      }

      const expectedDeltaIds = new Set<string>();
      for (const id of citedIds) {
        const source = sourceParameter(evidenceById.get(id), rationale.parameter);
        if (source.present && JSON.stringify(source.value) !== JSON.stringify(rationale.proposedValue)) {
          expectedDeltaIds.add(id);
        }
      }

      for (const id of expectedDeltaIds) {
        if (!deltaIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index, 'deltas'],
            message: `A changed value from evidence ${id} needs an explicit delta.`
          });
        }
      }

      for (const delta of rationale.deltas) {
        const id = delta.evidenceId;
        const source = sourceParameter(evidenceById.get(id), rationale.parameter);
        if (!citedIds.has(id) || !source.present || !expectedDeltaIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index, 'deltas'],
            message: `Delta ${id} must reference a cited source value that differs.`
          });
          continue;
        }
        const sourceValue = source.value;
        if (JSON.stringify(delta.sourceValue) !== JSON.stringify(sourceValue)) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index, 'deltas'],
            message: `Delta source value must match evidence ${id}.`
          });
        }
        if (typeof sourceValue === 'number' && typeof rationale.proposedValue === 'number') {
          if (delta.delta === rationale.proposedValue - sourceValue) continue;
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index, 'deltas'],
            message: `Numeric delta must equal proposed value minus evidence ${id}.`
          });
        } else if (delta.delta !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['parameterRationale', index, 'deltas'],
            message: `Non-numeric delta ${id} must explain the change without a numeric delta.`
          });
        }
      }
    });

    proposal.conflicts.forEach((conflict, index) => {
      for (const id of conflict.evidenceIds) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['conflicts', index], message: `Unknown evidence id: ${id}.` });
        }
      }
    });
  });

export type RecipeProposal = z.infer<typeof RecipeProposalSchema>;
export type UnverifiedRecipeProposal = RecipeProposal;
export const RecipeProposalJsonSchema = z.toJSONSchema(RecipeProposalSchema, { io: 'input' });

/** Parse an unverified document. Apply code must resolve its provenance against current stores. */
export function parseRecipeProposal(serialized: string): UnverifiedRecipeProposal {
  return RecipeProposalSchema.parse(JSON.parse(serialized));
}
