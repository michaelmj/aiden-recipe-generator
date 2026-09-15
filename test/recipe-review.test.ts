import { describe, expect, test } from 'bun:test';
import type { FellowClient } from '@/fellow/client';
import {
  AIDEN_RATIONALE_PARAMETERS,
  type CoffeeIdentity,
  evidenceFromExternalClaim,
  rankEvidence
} from '@/recipes/proposal';
import {
  applyReviewedRecipeProposal,
  cancelRecipeProposalReview,
  previewRecipeProposal,
  validateRecipeProposal
} from '@/recipes/review';
import { AidenCreateProfileSchema } from '@/schemas';
import { blockedNetworkCalls, clearBlockedNetworkCalls, freshDataDir } from './helpers/offline';

const COFFEE: CoffeeIdentity = { name: 'Danche', origin: 'Ethiopia', roastLevel: 'light', processing: 'washed' };
const TARGET = { mode: 'single-serve' as const, volumeMl: 450 };
const PROFILE = AidenCreateProfileSchema.parse({
  title: 'Danche Ethiopia',
  overallTemperature: null,
  ratio: 17,
  bloomEnabled: true,
  bloomRatio: 2,
  bloomDuration: 45,
  bloomTemperature: 96,
  ssPulsesEnabled: true,
  ssPulsesNumber: 2,
  ssPulsesInterval: 20,
  ssPulseTemperatures: [96, 95],
  batchPulsesEnabled: true,
  batchPulsesNumber: 2,
  batchPulsesInterval: 20,
  batchPulseTemperatures: [96, 95]
});

function proposalFixture() {
  const evidence = rankEvidence(COFFEE, TARGET, [
    evidenceFromExternalClaim({
      id: 'roaster-1',
      kind: 'roaster-guidance',
      title: 'Roaster guidance',
      provenance: { type: 'url', url: 'https://example.test/danche', retrievedAt: '2026-09-15T02:00:00Z' },
      coffee: COFFEE,
      sourceParameters: { ratio: 16 },
      observations: ['Use a high brew temperature.']
    })
  ]);
  return {
    version: 1 as const,
    proposalId: 'proposal-review-1',
    createdAt: '2026-09-15T03:00:00Z',
    evidenceVerification: 'required-before-apply' as const,
    coffee: COFFEE,
    target: TARGET,
    profile: PROFILE,
    evidence,
    assumptions: [],
    evidenceGaps: [],
    conflicts: [],
    parameterRationale: AIDEN_RATIONALE_PARAMETERS.map((parameter) => ({
      parameter,
      proposedValue: PROFILE[parameter] ?? null,
      reason: 'Selected from ranked evidence and device limits.',
      evidenceIds: ['roaster-1'],
      assumptionIds: [],
      deltas:
        parameter === 'ratio'
          ? [{ evidenceId: 'roaster-1', sourceValue: 16, delta: 1, explanation: 'Adjusted for this brew target.' }]
          : []
    })),
    confidence: { overall: 0.8, explanation: 'Attributable roaster guidance is available.' }
  };
}

describe('recipe review and apply workflow', () => {
  test('validates and previews locally with full write details and no network', async () => {
    freshDataDir();
    clearBlockedNetworkCalls();
    const proposal = proposalFixture();
    const validated = validateRecipeProposal(proposal);
    const preview = await previewRecipeProposal({ deviceId: 'device-1', proposal, nowMs: 1_000 });

    expect(preview).toMatchObject({
      action: 'create-profile',
      deviceId: 'device-1',
      title: PROFILE.title,
      proposalId: proposal.proposalId,
      expiresAt: 1_000 + 15 * 60 * 1_000,
      evidenceQuality: { sourceCount: 1, topTrustTier: 'attributed', confidence: 0.8 }
    });
    expect(preview.profile).toEqual(PROFILE);
    expect(preview.proposalHash).toBe(validated.proposalHash);
    expect(blockedNetworkCalls()).toEqual([]);
  });

  test('rejects altered proposal, wrong device, expiry, and replay before Fellow write', async () => {
    freshDataDir();
    const calls: unknown[] = [];
    const fellow = {
      createProfile: async (args: unknown) => {
        calls.push(args);
        return { id: 'remote-profile-1' };
      }
    } as unknown as FellowClient;
    const proposal = proposalFixture();
    const preview = await previewRecipeProposal({ deviceId: 'device-1', proposal, nowMs: 1_000, ttlMs: 100 });

    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-1',
        approvalId: preview.approvalId,
        proposal: { ...proposal, profile: { ...PROFILE, ratio: 18 } },
        nowMs: 1_010
      })
    ).rejects.toThrow();
    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-2',
        approvalId: preview.approvalId,
        proposal,
        nowMs: 1_010
      })
    ).rejects.toThrow(/different device/);
    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-1',
        approvalId: preview.approvalId,
        proposal,
        nowMs: 1_100
      })
    ).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
  });

  test('applies one exact reviewed profile and rejects replay', async () => {
    freshDataDir();
    const calls: Array<{ deviceId: string; profile: unknown }> = [];
    const fellow = {
      createProfile: async (args: { deviceId: string; profile: unknown }) => {
        calls.push(args);
        return { id: 'remote-profile-1' };
      }
    } as unknown as FellowClient;
    const proposal = proposalFixture();
    const preview = await previewRecipeProposal({ deviceId: 'device-1', proposal, nowMs: 1_000 });

    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-1',
        approvalId: preview.approvalId,
        proposal,
        nowMs: 2_000
      })
    ).resolves.toEqual({ ok: true, proposalId: proposal.proposalId, deviceId: 'device-1', id: 'remote-profile-1' });
    expect(calls).toEqual([{ deviceId: 'device-1', profile: PROFILE }]);
    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-1',
        approvalId: preview.approvalId,
        proposal,
        nowMs: 2_001
      })
    ).rejects.toThrow(/already applied/);
    expect(calls).toHaveLength(1);
  });

  test('cancellation leaves remote state untouched', async () => {
    freshDataDir();
    const fellow = { createProfile: async () => ({ id: 'must-not-be-called' }) } as unknown as FellowClient;
    const proposal = proposalFixture();
    const preview = await previewRecipeProposal({ deviceId: 'device-1', proposal, nowMs: 1_000 });
    await expect(cancelRecipeProposalReview({ approvalId: preview.approvalId, nowMs: 1_001 })).resolves.toEqual({
      ok: true
    });
    await expect(
      applyReviewedRecipeProposal({
        fellow,
        deviceId: 'device-1',
        approvalId: preview.approvalId,
        proposal,
        nowMs: 1_002
      })
    ).rejects.toThrow(/cancelled/);
  });
});
