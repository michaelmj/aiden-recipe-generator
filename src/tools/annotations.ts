/**
 * MCP safety annotations for every tool, reviewed in one place.
 *
 * These are host-facing hints, not an authorization control: a host may use them to decide which
 * calls need approval, but nothing here stops a call. The server's own checks (title identity,
 * hash-bound proposal approvals, the HTTP token and Origin checks) are what actually guard writes.
 *
 * What each hint means here:
 * - readOnlyHint: the call changes nothing — not the brewer, not the Fellow session, not any file
 *   in the data dir (brew log, settings, sheet cache, pending proposal approvals).
 * - destructiveHint: the call can delete or overwrite something the user would miss — a profile on
 *   the brewer, the stored Fellow session, feedback or a recipe already in the brew log, saved
 *   settings. Purely additive writes are not destructive. Only meaningful when not read-only.
 * - idempotentHint: repeating the call with the same arguments has no further effect. Title
 *   uniqueness makes profile creation and restore idempotent (a second call is refused or reports
 *   the existing profile); appending a new brew-log entry or minting a new approval is not.
 * - openWorldHint: the call can reach Fellow's cloud API or the operator-configured community
 *   sheet, or returns content cached from that stranger-written sheet. Local-file-only tools are
 *   closed-world.
 *
 * annotationsFor only accepts names listed here, and test/tool-annotations.test.ts fails when a
 * tool reaches tools/list without all four hints or without an entry in this table.
 */

export interface SafetyAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ_LOCAL: SafetyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const READ_OPEN_WORLD: SafetyAnnotations = { ...READ_LOCAL, openWorldHint: true };

export const TOOL_ANNOTATIONS = {
  // Sends credentials to Fellow and replaces any stored session with the new one (same account
  // either way, so not counted as destructive).
  'auth.login': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Reads the stored session file only; never refreshes or calls Fellow.
  'auth.status': READ_LOCAL,
  // Deletes the stored session (and any remembered password); local only.
  'auth.logout': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },

  'aiden.listDevices': READ_OPEN_WORLD,
  'aiden.getDevice': READ_OPEN_WORLD,
  'aiden.listProfiles': READ_OPEN_WORLD,
  // Additive; a second call with the same title is refused.
  'aiden.createProfile': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Overwrites the profile's current settings.
  'aiden.updateProfile': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  'aiden.deleteProfile': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },

  // Pure computation over the arguments.
  'recipe.validateProposal': READ_LOCAL,
  // Mints a new short-lived local approval on every call; no Fellow call.
  'recipe.previewProposal': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  },
  // Creates a profile on the brewer; the approval is single-use, so a replay is refused.
  'recipe.applyProposal': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Discards an ephemeral approval the user can mint again; nothing of theirs is lost.
  'recipe.cancelProposalReview': {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },

  // Fetches the operator-configured sheet and rewrites its local cache.
  'sheet.sync': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Local reads, but results can carry stranger-written rows cached from the configured sheet.
  'sheet.list': READ_OPEN_WORLD,
  'sheet.search': READ_OPEN_WORLD,

  // Appends a new entry each call; reads the recipe from the brewer when given a deviceId.
  'storage.logBrew': { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Replaces the entry's recipe, whatever it held; may read it from the brewer.
  'storage.completeRecipe': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Creates a profile on the brewer; an existing Custom profile with the title is reported, not duplicated.
  'storage.restoreProfile': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Replaces any feedback the entry already had.
  'storage.addFeedback': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  'storage.getHistory': READ_LOCAL,
  'storage.search': READ_LOCAL,
  'storage.findSimilar': READ_LOCAL,

  'user.getSettings': READ_LOCAL,
  // Overwrites the named preference fields.
  'user.updateSettings': { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
} as const satisfies Record<string, SafetyAnnotations>;

export type AnnotatedToolName = keyof typeof TOOL_ANNOTATIONS;

/** The reviewed annotations for a tool, as a fresh object for registerTool. */
export function annotationsFor(name: AnnotatedToolName): SafetyAnnotations {
  return { ...TOOL_ANNOTATIONS[name] };
}
