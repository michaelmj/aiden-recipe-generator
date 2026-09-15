/** Local review boundary for applying a validated recipe proposal to Fellow. */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { getAppDataDir } from '@/config';
import type { FellowClient } from '@/fellow/client';
import { parseRecipeProposal, type RecipeProposal, RecipeProposalSchema } from '@/recipes/proposal';
import { ResourceIdSchema } from '@/schemas';
import { atomicWriteStore, readStore, withStoreLock } from '@/storage/jsonStore';

export const REVIEW_TTL_MS = 15 * 60 * 1_000;

const ApprovalSchema = z.strictObject({
  approvalId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^review-[A-Za-z0-9-]+$/),
  proposalHash: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
  deviceId: ResourceIdSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  status: z.enum(['active', 'applied', 'cancelled']),
  completedAt: z.number().int().nonnegative().optional()
});
type Approval = z.infer<typeof ApprovalSchema>;

const ApprovalStoreSchema = z.strictObject({ approvals: z.array(ApprovalSchema).max(100) });
const APPROVALS_FILE = 'recipe-review-approvals.json';
const MAX_APPROVALS_BYTES = 128 * 1024;

export type RecipeProposalInput = z.input<typeof RecipeProposalSchema>;

export const RecipeProposalPreviewSchema = z.strictObject({
  approvalId: ApprovalSchema.shape.approvalId,
  proposalHash: ApprovalSchema.shape.proposalHash,
  expiresAt: z.number().int().nonnegative(),
  action: z.literal('create-profile'),
  deviceId: ResourceIdSchema,
  version: RecipeProposalSchema.shape.version,
  proposalId: RecipeProposalSchema.shape.proposalId,
  coffee: RecipeProposalSchema.shape.coffee,
  target: RecipeProposalSchema.shape.target,
  title: z.string(),
  profile: RecipeProposalSchema.shape.profile,
  evidenceQuality: z.strictObject({
    sourceCount: z.number().int().nonnegative(),
    topTrustTier: z.string().nullable(),
    untrustedSourceCount: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1)
  }),
  confidence: RecipeProposalSchema.shape.confidence,
  assumptions: RecipeProposalSchema.shape.assumptions,
  parameterRationale: RecipeProposalSchema.shape.parameterRationale,
  warnings: z.array(z.string()),
  conflicts: RecipeProposalSchema.shape.conflicts,
  evidenceGaps: RecipeProposalSchema.shape.evidenceGaps
});
export type RecipeProposalPreview = z.infer<typeof RecipeProposalPreviewSchema>;

export const ApplyRecipeProposalResultSchema = z.strictObject({
  ok: z.literal(true),
  proposalId: RecipeProposalSchema.shape.proposalId,
  deviceId: ResourceIdSchema,
  id: z.string().optional()
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

/** Hash canonical proposal content so JSON key order cannot change its identity. */
export function recipeProposalHash(input: RecipeProposalInput | RecipeProposal): string {
  const proposal = RecipeProposalSchema.parse(input);
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(proposal)))
    .digest('hex');
}

export function validateRecipeProposal(input: RecipeProposalInput | RecipeProposal) {
  const proposal = RecipeProposalSchema.parse(input);
  return { proposalId: proposal.proposalId, proposalHash: recipeProposalHash(proposal) };
}

async function approvalPath(): Promise<string> {
  const dir = getAppDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return join(dir, APPROVALS_FILE);
}

async function readApprovals(path: string) {
  return readStore(path, ApprovalStoreSchema, () => ({ approvals: [] }), MAX_APPROVALS_BYTES);
}

function pruneApprovals(approvals: Approval[], nowMs: number): Approval[] {
  return approvals.filter((approval) => approval.status === 'active' && approval.expiresAt > nowMs);
}

function previewWarnings(proposal: RecipeProposal): string[] {
  return [
    ...proposal.evidence.flatMap((evidence) => evidence.sourceWarnings),
    ...proposal.evidenceGaps.map(
      (gap) => `${gap.field}: ${gap.reason}${gap.requiredForApply ? ' Required for apply.' : ''}`
    ),
    ...proposal.conflicts.map((conflict) => `${conflict.field}: ${conflict.summary} Resolution: ${conflict.resolution}`)
  ];
}

function buildPreview(proposal: RecipeProposal, approval: Approval): RecipeProposalPreview {
  const untrustedSourceCount = proposal.evidence.filter(
    (evidence) => evidence.trustTier === 'untrusted-third-party'
  ).length;
  return RecipeProposalPreviewSchema.parse({
    approvalId: approval.approvalId,
    proposalHash: approval.proposalHash,
    expiresAt: approval.expiresAt,
    action: 'create-profile',
    deviceId: approval.deviceId,
    version: proposal.version,
    proposalId: proposal.proposalId,
    coffee: proposal.coffee,
    target: proposal.target,
    title: proposal.profile.title,
    profile: proposal.profile,
    evidenceQuality: {
      sourceCount: proposal.evidence.length,
      topTrustTier: proposal.evidence[0]?.trustTier ?? null,
      untrustedSourceCount,
      confidence: proposal.confidence.overall
    },
    confidence: proposal.confidence,
    assumptions: proposal.assumptions,
    parameterRationale: proposal.parameterRationale,
    warnings: previewWarnings(proposal),
    conflicts: proposal.conflicts,
    evidenceGaps: proposal.evidenceGaps
  });
}

/** Create a short-lived local review record. No Fellow call occurs. */
export async function previewRecipeProposal(args: {
  deviceId: string;
  proposal: RecipeProposalInput | RecipeProposal;
  nowMs?: number;
  ttlMs?: number;
}): Promise<RecipeProposalPreview> {
  const deviceId = ResourceIdSchema.parse(args.deviceId);
  const proposal = RecipeProposalSchema.parse(args.proposal);
  const nowMs = args.nowMs ?? Date.now();
  const ttlMs = args.ttlMs ?? REVIEW_TTL_MS;
  if (!Number.isInteger(nowMs) || nowMs < 0) throw new Error('Review time must be a non-negative integer.');
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > REVIEW_TTL_MS) {
    throw new Error(`Review expiry must be between 1 and ${REVIEW_TTL_MS} milliseconds.`);
  }

  const approval: Approval = {
    approvalId: `review-${randomUUID()}`,
    proposalHash: recipeProposalHash(proposal),
    deviceId,
    createdAt: nowMs,
    expiresAt: nowMs + ttlMs,
    status: 'active'
  };
  const path = await approvalPath();
  await withStoreLock(path, async () => {
    const store = await readApprovals(path);
    store.approvals = [...pruneApprovals(store.approvals, nowMs), approval];
    await atomicWriteStore(path, store);
  });
  return buildPreview(proposal, approval);
}

async function reserveApproval(args: {
  approvalId: string;
  deviceId: string;
  proposalHash: string;
  nowMs: number;
}): Promise<void> {
  const approvalId = ApprovalSchema.shape.approvalId.parse(args.approvalId);
  const deviceId = ResourceIdSchema.parse(args.deviceId);
  const path = await approvalPath();
  await withStoreLock(path, async () => {
    const store = await readApprovals(path);
    const approval = store.approvals.find((candidate) => candidate.approvalId === approvalId);
    if (!approval || approval.status !== 'active')
      throw new Error('Review approval is missing, cancelled, or already applied.');
    if (approval.expiresAt <= args.nowMs) throw new Error('Review approval expired; preview the proposal again.');
    if (approval.deviceId !== deviceId) throw new Error('Review approval is bound to a different device.');
    if (approval.proposalHash !== args.proposalHash)
      throw new Error('Proposal changed after review; preview the exact proposal again.');
    approval.status = 'applied';
    approval.completedAt = args.nowMs;
    await atomicWriteStore(path, store);
  });
}

/** Apply exactly one reviewed proposal. Reservation happens before the Fellow write to prevent replay. */
export async function applyReviewedRecipeProposal(args: {
  fellow: FellowClient;
  deviceId: string;
  proposal: RecipeProposalInput | RecipeProposal;
  approvalId: string;
  nowMs?: number;
}): Promise<{ ok: true; proposalId: string; deviceId: string; id?: string }> {
  const deviceId = ResourceIdSchema.parse(args.deviceId);
  const proposal = RecipeProposalSchema.parse(args.proposal);
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isInteger(nowMs) || nowMs < 0) throw new Error('Apply time must be a non-negative integer.');
  await reserveApproval({
    approvalId: args.approvalId,
    deviceId,
    proposalHash: recipeProposalHash(proposal),
    nowMs
  });
  const result = await args.fellow.createProfile({ deviceId, profile: proposal.profile });
  return { ok: true, proposalId: proposal.proposalId, deviceId, id: result?.id as string | undefined };
}

/** Cancel a review token. Cancellation only changes local state and never contacts Fellow. */
export async function cancelRecipeProposalReview(args: { approvalId: string; nowMs?: number }): Promise<{ ok: true }> {
  const approvalId = ApprovalSchema.shape.approvalId.parse(args.approvalId);
  const nowMs = args.nowMs ?? Date.now();
  if (!Number.isInteger(nowMs) || nowMs < 0) throw new Error('Cancellation time must be a non-negative integer.');
  const path = await approvalPath();
  await withStoreLock(path, async () => {
    const store = await readApprovals(path);
    const approval = store.approvals.find((candidate) => candidate.approvalId === approvalId);
    if (!approval || approval.status !== 'active')
      throw new Error('Review approval is missing, cancelled, or already applied.');
    approval.status = 'cancelled';
    approval.completedAt = nowMs;
    await atomicWriteStore(path, store);
  });
  return { ok: true };
}

/** Parse serialized proposals for callers that keep proposal JSON outside MCP structured content. */
export function parseReviewProposal(serialized: string): RecipeProposal {
  return parseRecipeProposal(serialized);
}
