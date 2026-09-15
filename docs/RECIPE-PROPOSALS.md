# Recipe proposal contract

`RecipeProposalSchema` is the versioned boundary between research and any Fellow profile write. A
proposal is local, reviewable JSON. Parsing or ranking it performs no network request and cannot
write to a brewer. Applying a reviewed proposal is a separate workflow. Serialized proposals carry
`evidenceVerification: required-before-apply`; parsing validates structure but cannot authenticate
local ids after JSON round-trip. Apply code must resolve those ids against current stores.

Version 1 contains:

- normalized coffee identity and target brew mode/volume
- a complete `AidenCreateProfileSchema` payload
- ranked evidence with stable provenance, trust tier, observations, warnings, and optional outcomes
- canonically validated partial source parameters when evidence does not contain a complete profile
- explicit model assumptions, missing evidence, source conflicts, confidence, and conflict resolution
- one rationale for every writable brew parameter, linked back to evidence and assumptions
- source-value deltas where a proposed parameter differs from cited evidence

## Evidence trust and ranking

Ranking uses integer components from `EVIDENCE_RANKING_WEIGHTS`. Higher totals rank first.

| Evidence kind | Trust score | Why |
|---|---:|---|
| tasted first-party history | 120 | operator brewed and rated it |
| bundled first-party recipe | 105 | reviewed local record from operator |
| current roaster guidance | 85 | attributable guidance from coffee producer |
| bundled roaster guidance | 80 | attributable reviewed snapshot |
| reviewed community snapshot | 60 | stranger-authored, but reviewed before shipping |
| web review | 40 | attributable third-party report |
| live community sheet | 30 | mutable stranger-authored input |

Exact normalized identity matches add: coffee name 30, roaster 20, origin 18, processing 16, roast
level 12, varietal 8, brew mode 6, and volume within 50 ml 6. Rated outcomes add 30 for 5/5, 20 for
4/5, 0 for 3/5, subtract 15 for 2/5, and subtract 30 for 1/5.

Tie-breakers are total score, trust score, similarity score, outcome score, then evidence id in
lexical order. Input order and current time never affect ranking. First-party history only receives
its highest trust class after tasting feedback supplies a rating. Uncited model knowledge never
enters the evidence list; record it in `assumptions` with confidence and affected parameters.

Trust tiers validate provenance shape; they do not authenticate arbitrary JSON. `rankEvidence`
accepts only opaque candidates stamped by an evidence adapter. `evidenceFromBrewHistory` and
`evidenceFromBundledRecipe` assign authoritative kinds from local records;
`evidenceFromExternalClaim` can only assign lower-trust roaster, live-sheet, and web kinds. Never
promote a model-supplied label into a trusted evidence kind.

Authoritative adapters derive every claim from the local record. Brew-log and bundled-recipe records
do not currently store brew mode or volume, so their evidence has no target; callers cannot add one.
Partial history and source values are retained in `sourceParameters` and receive the same exact
rationale/delta checks as values from a complete source profile.

## Completeness and conflicts

`evidenceGaps` and `conflicts` are required arrays, even when empty. Evidence references must resolve
to an evidence id in the proposal. Each rationale's proposed value must equal the canonical profile
value. These cross-field checks stop a narrative explanation from drifting away from the payload a
reviewer sees.

Source records have their own `complete`, `incomplete`, or `invalid` classification. Only a complete
source can convert directly through `toAidenCreateProfile`; incomplete fields and invalid/conflicting
values remain explicit evidence warnings when building a proposal.

## Review and apply workflow

Use `recipe.validateProposal` to validate local proposal JSON and compute its canonical SHA-256
content hash. Use `recipe.previewProposal` with the exact `deviceId` to create a short-lived local
review approval and display the device, title, every writable profile parameter, evidence quality,
assumptions, warnings, conflicts, and evidence gaps. This phase never calls Fellow's write API.

After the operator reviews that preview, call `recipe.applyProposal` with the same proposal,
`deviceId`, and returned `approvalId`. The local approval stores the proposal hash and device id;
changed parameters, a different device, expired approvals, cancelled approvals, and replayed
approvals are rejected. The approval is reserved before the single bounded `createProfile` call,
so one approval cannot cause duplicate writes. Call `recipe.cancelProposalReview` to cancel without
contacting Fellow.
