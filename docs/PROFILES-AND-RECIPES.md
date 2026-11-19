# Profiles and Recipes

How this server names brew profiles and what it means by a recipe. Covers epic
aiden-recipe-generator-46y: beads 46y.1 (naming by title) and 46y.2 (full recipes).

## Profiles are named by title, never by id

Fellow gives each profile on an Aiden an id such as `p0` or `p9`. That id is a **slot index,
not an identity**. When a profile is deleted, its slot is freed, and the next profile created
takes it over. On the operator's brewer, `p9` was *Alinea - Colombia*, then after a delete it
became *Elevator - Arsosala*.

The operator keeps only the coffees they are currently drinking on the Aiden and deletes the
rest, so slots get reused often. Anything saved by id (a brew log entry, a note, a tool call
built from old output) would later point at a different coffee. So:

- **Every tool names a profile by its exact title**, as `aiden.listProfiles` shows it.
  `aiden.updateProfile` and `aiden.deleteProfile` take `title`, `storage.logBrew` takes
  `profileTitle`, and the `troubleshoot` prompt takes `profileTitle`. No tool takes a profile
  id as input.
- **The id is looked up at the moment of each write.** `FellowClient` lists the device's
  profiles and finds the one with that title, then PATCHes or DELETEs whatever slot holds it
  right now. A slot that has been reused can't be reached through the old coffee's name: that
  name simply isn't found.
- **Ambiguous or missing titles are refused, with no write:**
  - If no profile has the title, the error lists the Custom titles that are on the device.
  - If two Custom profiles share a title, the tools refuse, because either could be meant.
    Rename or delete the extra copy in the Fellow app first.
- **Creating a profile never makes a duplicate title.** `aiden.createProfile`,
  `recipe.applyProposal` and `storage.restoreProfile` refuse a title a Custom profile already
  has, and so does `aiden.updateProfile` when it renames a profile. A Custom profile may share
  a title with a Fellow default or a Drops profile, because only Custom titles have to be unique.
- **Results name profiles by title.** Create, restore and apply report `title`, not the new
  slot. `aiden.listProfiles` still shows `id` for information only.

Lookups prefer the Custom folder. A title found only among Fellow or Drops profiles can still
be read (for example, to log a brew made on a Fellow default), but it is never written to.

## A recipe is the whole brew

`RecipeSchema` in `src/schemas.ts` defines the one recipe shape. It is every brewing parameter
of a profile, without its title or type:

| Part | Fields |
|---|---|
| Strength | `ratio` (14–20, steps of 0.5); optional `overallTemperature` |
| Bloom | `bloomEnabled`, `bloomRatio` (1–3× coffee weight), `bloomDuration` (s), `bloomTemperature` (°C) |
| Single-serve pulses | `ssPulsesEnabled`, `ssPulsesNumber`, `ssPulsesInterval` (s), `ssPulseTemperatures` (one per pulse) |
| Batch pulses | `batchPulsesEnabled`, `batchPulsesNumber`, `batchPulsesInterval` (s, default 30), `batchPulseTemperatures` |

The limits are the brewer's own (`AIDEN_LIMITS`), and there can't be more pulse temperatures
than pulses. A profile write (`AidenCreateProfileSchema`) is exactly a recipe plus `title` and
`profileType`.

The same shape is used everywhere a recipe appears:

- **Brew log.** Each entry stores `profile: { title, recipe }`.
- **Recipe search.** `sheet.search` and `sheet.list` add `recipe` to each record. They keep
  the raw source fields too, so a reader can see what the source said.
- **Proposals.** `proposal.profile` is a full profile write: title plus recipe.

## Brew history is the archive

Profiles leave the brewer, but the brew log keeps them:

1. **Logging.** `storage.logBrew` records the coffee and the full recipe. Pass `deviceId`
   and `profileTitle`, and the recipe is read from the profile with that title. Or pass
   `recipe` directly. If it can't get a recipe, it refuses rather than logging a summary.
2. **Feedback.** `storage.addFeedback` attaches a rating and notes to the entry.
3. **Restoring.** When a coffee comes back, `storage.restoreProfile` writes a logged recipe
   to the brewer as a Custom profile. Name a `brewId`, or a `query` (coffee, roaster, origin
   or profile title) to use the best-rated match, newest first among equal ratings. If a
   Custom profile with that title is already on the device, it is reported instead of
   duplicated. You can pass a different `title`; it must follow the brewer's title rules.

Tasted entries also feed recipe proposals as the highest-trust evidence. The full recipe
becomes the evidence's source parameters.

## Older, partial entries

Entries logged before 46y.2 recorded only ratio, bloom temperature and bloom duration. Some
also kept an archived `settings` snapshot, and many kept the device slot id. They still load:

- **An entry with `settings`** becomes a full entry, with its recipe taken from those settings.
- **An entry without `settings`** is shown as
  `{ title, partial: true, recipe: { ratio, bloomTemperature, bloomDuration } }`.
  A partial entry can't be restored, because a profile can't be rebuilt from ratio and bloom
  alone.
- **The legacy slot id is dropped.** It is never shown and never looked up.

The log file is rewritten in the new shape on the next write (a new brew or new feedback).
After that, an older build of this server would find the file unreadable and set it aside, so
restart `bun run serve` after upgrading.

To make a partial entry full again, call `storage.completeRecipe` with its `brewId` and either
a `deviceId` (the recipe is read from the profile with the entry's title) or a `recipe`. The
entry keeps its time, coffee and feedback.
