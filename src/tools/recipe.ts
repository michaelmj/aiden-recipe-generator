import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { FellowClient } from '@/fellow/client';
import { RecipeProposalSchema } from '@/recipes/proposal';
import {
  ApplyRecipeProposalResultSchema,
  applyReviewedRecipeProposal,
  cancelRecipeProposalReview,
  previewRecipeProposal,
  RecipeProposalPreviewSchema,
  validateRecipeProposal
} from '@/recipes/review';
import { ResourceIdSchema } from '@/schemas';
import { toolResponse } from '@/tools/response';

export function registerRecipeTools(server: McpServer, fellow: FellowClient) {
  server.registerTool(
    'recipe.validateProposal',
    {
      title: 'Validate Recipe Proposal',
      description:
        'Validate a local recipe proposal and compute its immutable content hash. This performs no Fellow call.',
      inputSchema: { proposal: RecipeProposalSchema },
      outputSchema: { valid: z.literal(true), proposalId: z.string(), proposalHash: z.string() }
    },
    async ({ proposal }) => toolResponse({ valid: true, ...validateRecipeProposal(proposal) })
  );

  server.registerTool(
    'recipe.previewProposal',
    {
      title: 'Preview Recipe Proposal',
      description:
        'Validate and render the exact device, title, full profile parameters, evidence quality, assumptions, and warnings. ' +
        'Creates a short-lived local review approval but makes no Fellow write.',
      inputSchema: { deviceId: ResourceIdSchema, proposal: RecipeProposalSchema },
      outputSchema: RecipeProposalPreviewSchema.shape
    },
    async ({ deviceId, proposal }) => toolResponse(await previewRecipeProposal({ deviceId, proposal }))
  );

  server.registerTool(
    'recipe.applyProposal',
    {
      title: 'Apply Reviewed Recipe Proposal',
      description:
        'Apply one exact proposal only after recipe.previewProposal returned its approvalId. The approval binds device and all profile parameters, expires, and cannot be replayed.',
      inputSchema: {
        deviceId: ResourceIdSchema,
        approvalId: z.string().min(1).max(128),
        proposal: RecipeProposalSchema
      },
      outputSchema: ApplyRecipeProposalResultSchema.shape
    },
    async ({ deviceId, approvalId, proposal }) =>
      toolResponse(await applyReviewedRecipeProposal({ fellow, deviceId, approvalId, proposal }))
  );

  server.registerTool(
    'recipe.cancelProposalReview',
    {
      title: 'Cancel Recipe Proposal Review',
      description: 'Cancel a pending local recipe review. Cancellation makes no Fellow call.',
      inputSchema: { approvalId: z.string().min(1).max(128) },
      outputSchema: { ok: z.literal(true) }
    },
    async ({ approvalId }) => toolResponse(await cancelRecipeProposalReview({ approvalId }))
  );
}
