import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AIDEN_RATIONALE_PARAMETERS,
  type CoffeeIdentity,
  EVIDENCE_RANKING_WEIGHTS,
  evidenceFromBrewHistory,
  evidenceFromBundledRecipe,
  evidenceFromExternalClaim,
  parseRecipeProposal,
  RecipeProposalJsonSchema,
  RecipeProposalSchema,
  rankEvidence,
  type VerifiedEvidenceCandidate
} from '@/recipes/proposal';
import { AidenCreateProfileSchema } from '@/schemas';

const COFFEE: CoffeeIdentity = {
  name: 'Danche',
  roaster: 'Wonderstate',
  origin: 'Gedeb, Ethiopia',
  roastLevel: 'light',
  processing: 'Washed',
  varietal: 'Landrace'
};

const TARGET = { mode: 'single-serve' as const, volumeMl: 450 };

const PROFILE = AidenCreateProfileSchema.parse({
  title: 'Wonderstate Ethiopia Danche',
  overallTemperature: null,
  ratio: 17,
  bloomEnabled: true,
  bloomRatio: 3,
  bloomDuration: 45,
  bloomTemperature: 96,
  ssPulsesEnabled: true,
  ssPulsesNumber: 7,
  ssPulsesInterval: 20,
  ssPulseTemperatures: [96, 96, 95.5, 95, 94.5, 94, 93],
  batchPulsesEnabled: true,
  batchPulsesNumber: 7,
  batchPulsesInterval: 20,
  batchPulseTemperatures: [96, 96, 95.5, 95, 94.5, 94, 93]
});

const HISTORY = evidenceFromBrewHistory({
  id: 'brew-1',
  timestamp: 1,
  coffee: { name: 'Another coffee', origin: 'Ethiopia', roast: 'Light', processing: 'Washed' },
  profile: { title: 'Past brew', ratio: 16, bloomTemp: 96, bloomDuration: 45 },
  feedback: { rating: 5, notes: 'Sweet and balanced.' }
});

const LIVE = evidenceFromExternalClaim({
  id: 'live-sheet-1',
  kind: 'live-community-sheet',
  title: 'Exact live sheet row',
  provenance: {
    type: 'live-sheet',
    url: 'https://docs.google.com/spreadsheets/d/example',
    rowRef: 'column-12',
    retrievedAt: '2026-09-15T02:00:00Z'
  },
  coffee: COFFEE,
  target: TARGET,
  sourceParameters: { ratio: 16 },
  observations: ['Exact coffee identity, but stranger-authored.']
});

const EVIDENCE = [HISTORY, LIVE];

function proposalFixture() {
  const evidence = rankEvidence(COFFEE, TARGET, EVIDENCE);
  return {
    version: 1 as const,
    proposalId: 'proposal-1',
    createdAt: '2026-09-15T03:00:00Z',
    evidenceVerification: 'required-before-apply' as const,
    coffee: COFFEE,
    target: TARGET,
    profile: PROFILE,
    evidence,
    assumptions: [
      {
        id: 'assumption-1',
        statement: 'Water chemistry is suitable for a light roast.',
        basis: 'No water composition was supplied.',
        confidence: 0.4,
        affectedParameters: ['bloomTemperature' as const]
      }
    ],
    evidenceGaps: [{ field: 'waterChemistry', reason: 'No mineral profile supplied.', requiredForApply: false }],
    conflicts: [
      {
        id: 'conflict-1',
        field: 'bloomTemperature',
        evidenceIds: ['history:brew-1', 'live-sheet-1'],
        summary: 'Sources recommend different bloom temperatures.',
        resolution: 'Prefer successful first-party history, adjusted for this exact coffee.'
      }
    ],
    parameterRationale: AIDEN_RATIONALE_PARAMETERS.map((parameter) => ({
      parameter,
      proposedValue: PROFILE[parameter],
      reason: `Selected ${parameter} from ranked evidence and canonical device limits.`,
      evidenceIds: ['history:brew-1', 'live-sheet-1'],
      assumptionIds: parameter === 'bloomTemperature' ? ['assumption-1'] : [],
      deltas:
        parameter === 'ratio'
          ? [
              {
                evidenceId: 'history:brew-1',
                sourceValue: 16,
                delta: 1,
                explanation: 'Raised ratio from the prior tasted brew.'
              },
              {
                evidenceId: 'live-sheet-1',
                sourceValue: 16,
                delta: 1,
                explanation: 'Raised ratio from 16 to 17 based on successful first-party history.'
              }
            ]
          : []
    })),
    confidence: { overall: 0.78, explanation: 'Relevant successful history exists; water chemistry is unknown.' }
  };
}

describe('evidence ranking', () => {
  test('favors relevant successful first-party history over an exact live-sheet row', () => {
    const ranked = rankEvidence(COFFEE, TARGET, EVIDENCE);
    expect(ranked.map((item) => item.id)).toEqual(['history:brew-1', 'live-sheet-1']);
    expect(ranked[0]?.ranking.outcomeScore).toBe(EVIDENCE_RANKING_WEIGHTS.rating[5]);
    expect(ranked[0]?.ranking.matchedFields).toContain('origin');
  });

  test('is independent of input order and resolves complete ties by stable id', () => {
    const twins = ['z-source', 'a-source'].map((id) =>
      evidenceFromExternalClaim({
        id,
        kind: 'web-review',
        title: id,
        provenance: {
          type: 'url',
          url: `https://example.test/${id}`,
          retrievedAt: '2026-09-15T02:00:00Z'
        },
        observations: ['Same score.']
      })
    );
    expect(rankEvidence(COFFEE, TARGET, twins).map((item) => item.id)).toEqual(['a-source', 'z-source']);
    expect(rankEvidence(COFFEE, TARGET, twins.reverse()).map((item) => item.id)).toEqual(['a-source', 'z-source']);
  });

  test('rejects raw claimed trust and unrated first-party history', () => {
    expect(() =>
      rankEvidence(COFFEE, TARGET, [
        {
          ...LIVE,
          kind: 'first-party-history',
          verification: 'authoritative',
          provenance: { type: 'brew-log', brewId: 'invented' },
          outcome: { rating: 5 }
        } as unknown as VerifiedEvidenceCandidate
      ])
    ).toThrow(/adapter/);
    expect(() =>
      evidenceFromBrewHistory({
        id: 'unrated',
        timestamp: 1,
        coffee: { name: 'Untasted' },
        profile: { title: 'Untasted', ratio: 16, bloomTemp: 96, bloomDuration: 45 }
      })
    ).toThrow(/feedback/);
  });

  test('rejects duplicate ids before input order can break a tie', () => {
    const duplicate = () =>
      evidenceFromExternalClaim({
        id: 'same',
        kind: 'web-review',
        title: 'Duplicate',
        provenance: { type: 'url', url: 'https://example.test/same', retrievedAt: '2026-09-15T02:00:00Z' },
        observations: ['Same id.']
      });
    expect(() => rankEvidence(COFFEE, TARGET, [duplicate(), duplicate()])).toThrow(/unique/);
  });

  test('does not award substring matches for short generic fragments', () => {
    const shortFragment = evidenceFromExternalClaim({
      id: 'short-fragment',
      kind: 'live-community-sheet',
      title: 'Short fragment',
      provenance: {
        type: 'live-sheet',
        url: 'https://docs.google.com/spreadsheets/d/example',
        rowRef: 'column-short',
        retrievedAt: '2026-09-15T02:00:00Z'
      },
      coffee: { name: 'Different', origin: 'e', roastLevel: 'unknown', processing: 'a' },
      observations: ['Generic fragments.']
    });
    const [ranked] = rankEvidence(COFFEE, TARGET, [shortFragment]);
    expect(ranked?.ranking.matchedFields).not.toContain('origin');
    expect(ranked?.ranking.matchedFields).not.toContain('processing');
  });

  test('authoritative adapters expose only source-backed targets and incomplete source warnings', () => {
    expect(HISTORY.target).toBeUndefined();
    expect(HISTORY.sourceParameters).toEqual({ ratio: 16, bloomDuration: 45, bloomTemperature: 96 });

    const bundled = evidenceFromBundledRecipe({
      id: 'incomplete-roaster',
      source: { kind: 'roaster', credit: 'Example Roaster' },
      title: 'Incomplete source',
      brewRatio: '16',
      validation: {
        status: 'incomplete',
        missingFields: [
          'bloomRatio',
          'bloomTime',
          'bloomTemp',
          'ssPulsesNumber',
          'ssPulsesInterval',
          'ssPulseTemps',
          'batchPulsesNumber',
          'batchPulseTemps'
        ],
        issues: []
      }
    });

    expect(bundled.target).toBeUndefined();
    expect(bundled.profile).toBeUndefined();
    expect(bundled.sourceParameters).toEqual({ ratio: 16 });
    expect(bundled.sourceWarnings).toContain('Profile conversion failed: source is incomplete.');
    expect(bundled.sourceWarnings).toContain('Missing required source field: bloomRatio.');
  });
});

describe('RecipeProposal contract', () => {
  test('round-trips representative JSON and emits a versioned JSON Schema', () => {
    const proposal = RecipeProposalSchema.parse(proposalFixture());
    expect(parseRecipeProposal(JSON.stringify(proposal))).toEqual(proposal);
    expect(RecipeProposalJsonSchema).toMatchObject({
      type: 'object',
      properties: { version: { const: 1 }, profile: { type: 'object' } }
    });
  });

  test('requires explicit gaps/conflicts and complete parameter rationale', () => {
    const missingDisclosures = { ...proposalFixture(), evidenceGaps: undefined, conflicts: undefined };
    expect(RecipeProposalSchema.safeParse(missingDisclosures).success).toBe(false);

    const incompleteRationale = proposalFixture();
    incompleteRationale.parameterRationale.pop();
    expect(RecipeProposalSchema.safeParse(incompleteRationale).success).toBe(false);
  });

  test('safeParse reports duplicate evidence ids without throwing', () => {
    const duplicate = proposalFixture();
    duplicate.evidence.push(structuredClone(duplicate.evidence[0]!));
    expect(() => RecipeProposalSchema.safeParse(duplicate)).not.toThrow();
    expect(RecipeProposalSchema.safeParse(duplicate).success).toBe(false);
  });

  test('rejects model-forged score breakdowns and evidence order', () => {
    const forged = proposalFixture();
    forged.evidence[1]!.ranking.totalScore = 999;
    expect(RecipeProposalSchema.safeParse(forged).success).toBe(false);

    const reordered = proposalFixture();
    reordered.evidence.reverse();
    reordered.evidence.forEach((item, index) => {
      item.ranking.position = index + 1;
    });
    expect(RecipeProposalSchema.safeParse(reordered).success).toBe(false);
  });

  test('rejects dangling evidence references and rationale values that disagree with the profile', () => {
    const dangling = proposalFixture();
    dangling.conflicts[0]!.evidenceIds[0] = 'missing-evidence';
    expect(RecipeProposalSchema.safeParse(dangling).success).toBe(false);

    const mismatch = proposalFixture();
    mismatch.parameterRationale[0]!.proposedValue = 999;
    expect(RecipeProposalSchema.safeParse(mismatch).success).toBe(false);
  });

  test('requires and verifies deltas from complete and partial cited source values', () => {
    const missingHistory = proposalFixture();
    missingHistory.parameterRationale.find((item) => item.parameter === 'ratio')!.deltas.shift();
    expect(RecipeProposalSchema.safeParse(missingHistory).success).toBe(false);

    const missingExternal = proposalFixture();
    missingExternal.parameterRationale.find((item) => item.parameter === 'ratio')!.deltas.pop();
    expect(RecipeProposalSchema.safeParse(missingExternal).success).toBe(false);

    const wrong = proposalFixture();
    wrong.parameterRationale.find((item) => item.parameter === 'ratio')!.deltas[0]!.delta = 99;
    expect(RecipeProposalSchema.safeParse(wrong).success).toBe(false);

    const extra = proposalFixture();
    extra.parameterRationale
      .find((item) => item.parameter === 'bloomRatio')!
      .deltas.push({
        evidenceId: 'history:brew-1',
        sourceValue: 2,
        delta: 1,
        explanation: 'Fabricated extra delta.'
      });
    expect(RecipeProposalSchema.safeParse(extra).success).toBe(false);
  });

  test('contract module has no Fellow client, MCP tool, or write dependency', () => {
    const source = readFileSync(new URL('../src/recipes/proposal.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@/fellow');
    expect(source).not.toContain('@modelcontextprotocol');
    expect(source).not.toMatch(/\.createProfile\s*\(/);
  });
});
