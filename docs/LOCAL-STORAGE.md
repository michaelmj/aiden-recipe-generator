# Local storage guarantees

`brew-log.json` and `user-settings.json` are model-writable inputs that later return to the model.
They are therefore validated on both API input and disk read; TypeScript assertions are not treated
as validation.

- Brew history is capped at 10,000 entries and 5 MiB. Settings are capped at 64 KiB.
- Individual source strings are rejected above 4,000 characters, stripped of terminal controls,
  bidi/invisible characters, and collapsed before storage/output. Ordinary fields are capped at 200
  characters; titles at 120; notes at 1,000.
- Ratios, bloom temperatures, bloom durations, and device IDs reuse the canonical Fellow schemas.
- Each brew entry stores the whole recipe brewed (`profile.recipe`, the canonical `RecipeSchema` in
  `src/schemas.ts`): bloom enabled/ratio/duration/temperature and the single-serve and batch pulse
  steps with their count, interval and per-pulse temperatures, validated like a profile write.
  The same shape is returned by `sheet.search`/`sheet.list` (`recipe`) and used by proposals.
  `storage.logBrew` takes the recipe or reads it from the device profile with the given title;
  it refuses to log without one. Profiles are named by title everywhere, never by device id:
  Fellow ids are slots reused after a delete. Two Custom profiles sharing a title are refused as
  ambiguous, and profiles the device reported anomalies for are not read.
- Entries logged before full recipes (aiden-recipe-generator-46y.2) still load: one that archived
  `settings` becomes a full entry; one that kept only ratio and bloom is shown as
  `{ title, partial: true, recipe: { ratio, bloomTemperature, bloomDuration } }`. Their legacy
  device slot id is dropped. The file is rewritten in the new shape on the next write, so an older
  server build reading it afterwards would set it aside as unreadable. `storage.completeRecipe`
  fills a partial entry in from the device or a given recipe, keeping its time and feedback.
  `storage.restoreProfile` writes a full entry's recipe back, reusing a Custom profile with the
  same title instead of duplicating it; partial entries cannot be restored until completed.
  Elevation is limited to -500 through 9,000 metres.
- Every in-process read-modify-write operation is serialized by file, preventing concurrent updates
  from overwriting one another.
- Writes use a same-directory mode-0600 temporary file followed by atomic rename. A partial temporary
  file is never read as the store and is removed when a write fails.
- Malformed, oversized, or schema-invalid files are renamed to a timestamped `.corrupt-*` sibling and
  produce a visible error. They are never silently replaced with an empty store.

Tests always relocate the data directory to an isolated temporary directory.
