# Bundled recipe dataset

`recipes.json` is the default recipe source for the MCP server. It ships with the code, so reading
it makes no network call and involves no third party — unlike the public community sheet, which any
stranger can edit and which is now opt-in (`AIDEN_AI_SHEET_CSV_URL`).

Loading it is still not the same as trusting it: `src/recipes/dataset.ts` validates every record and
runs it through the same sanitizer the sheet cells go through, and drops anything that fails.

## Format

```json
{
  "version": 1,
  "recipes": [
    {
      "id": "lowercase-slug",
      "source": { "kind": "first-party" },
      "title": "Ethiopia Guji Washed",
      "origin": "Ethiopia",
      "roast": "Light",
      "processing": "Washed",
      "varietal": "Heirloom",
      "brewRatio": "16.5",
      "bloomRatio": "2",
      "bloomTime": "45",
      "bloomTemp": "96.5",
      "ssPulsesNumber": "3",
      "ssPulsesInterval": "23",
      "ssPulseTemps": "96.5,95,94",
      "batchPulsesNumber": "2",
      "batchPulsesInterval": "30",
      "batchPulseTemps": "96,95",
      "notes": "Comandante C40, 22 clicks. Sweet, no astringency."
    }
  ]
}
```

Only `id`, `source` and `title` are required. Brewing values are strings because they go through the
same range checks as sheet cells, which parse them; a value outside what an Aiden can do is dropped.

### `source.kind`

| kind | meaning | trust |
|---|---|---|
| `first-party` | brewed and rated by the operator | highest — no stranger involved |
| `community-sheet` | from a reviewed snapshot of a credited public sheet | a human read the diff |
| `roaster` | a recommendation the roaster published for that coffee | named, attributable |

Anything not `first-party` should carry `credit` and, where there is one, `url`.

## Snapshots

Records that did not come from the operator's own brewing say where they did, and the file records
the snapshot they were taken from:

```json
{
  "version": 1,
  "snapshots": [
    {
      "source": "community-sheet",
      "credit": "Fellow Aiden community recipe sheet",
      "url": "https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA",
      "takenAt": "2026-09-13",
      "sha256": "1c510166f4ef4cbe785a20425b9cd03e3837086d1f2fc0648d318ad7a4f74a29"
    }
  ],
  "recipes": []
}
```

`sha256` is the digest of the CSV that was read, so a later refresh can show what changed instead of
asserting that nothing did.

## Refreshing the community snapshot

```bash
bun run snapshot:sheet   # → data/community-snapshot.json (git-ignored working file)
```

The script fetches the sheet once, through the same parser and caps as the live path, and writes one
candidate per column. It writes nothing the server reads: each candidate carries a `review.raw` key
holding the original cells, and that key is not part of the dataset format — a candidate pasted in
unreviewed is rejected by the loader rather than shipped.

Per candidate worth keeping:

1. Compare the sanitized fields against `review.raw`. They disagree routinely: the sheet writes brew
   ratios as `1:16`, and temperatures in Fahrenheit with Celsius in parentheses, so the range checks
   drop those cells — or salvage a misleading fragment of a pulse-temp list. Transcribe by hand from
   the sheet's Celsius figures.
2. Sanity-check the result against what an Aiden can do and against the roast level.
3. Delete `review`, keep `source` as `community-sheet` with its credit, and note anything odd about
   the original in `notes`.
4. Update the `snapshots` entry with the new date and `sha256` the script printed.

The diff someone reads in step 4 is the whole point: it is what keeps these recipes from being live
stranger input.
