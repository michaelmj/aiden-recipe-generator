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
