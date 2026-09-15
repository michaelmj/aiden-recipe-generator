# Local storage guarantees

`brew-log.json` and `user-settings.json` are model-writable inputs that later return to the model.
They are therefore validated on both API input and disk read; TypeScript assertions are not treated
as validation.

- Brew history is capped at 10,000 entries and 5 MiB. Settings are capped at 64 KiB.
- Individual source strings are rejected above 4,000 characters, stripped of terminal controls,
  bidi/invisible characters, and collapsed before storage/output. Ordinary fields are capped at 200
  characters; titles at 120; notes at 1,000.
- Ratios, bloom temperatures, bloom durations, and device IDs reuse the canonical Fellow schemas.
  Elevation is limited to -500 through 9,000 metres.
- Every in-process read-modify-write operation is serialized by file, preventing concurrent updates
  from overwriting one another.
- Writes use a same-directory mode-0600 temporary file followed by atomic rename. A partial temporary
  file is never read as the store and is removed when a write fails.
- Malformed, oversized, or schema-invalid files are renamed to a timestamped `.corrupt-*` sibling and
  produce a visible error. They are never silently replaced with an empty store.

Tests always relocate the data directory to an isolated temporary directory.
