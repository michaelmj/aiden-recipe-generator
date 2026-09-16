# Tasting-note tuning: prior art and evidence

Reference material for `aiden-recipe-generator-2o8.6` — "Tune proposed recipes to the bean's
tasting notes, not just roast level". Captured 2026-09-15. This is a research record, not a spec:
nothing here is implemented, and several of the numbers below are explicitly uncited.

## Why this exists

A generated recipe told the user it was "templated off your other dark roasts, not tuned
specifically to this bean's fig/black-tea/pepper profile". Roast level, origin, and processing steer
our parameters; the roaster's tasting notes are carried as text and never reach bloom, temp, ratio,
or pulse structure.

## Closest prior art: Sean Elvidge's pour-over recipe generator

- Article: <https://seanelvidge.com/articles/2025/Pour_over_brewing_recipe_generator/> (2025-03-31)
- Live tool: <https://seanelvidge.com/brewcoffee>

Same brewer (Fellow Aiden), same output fields we emit — brew ratio, bloom ratio, bloom time, bloom
temperature, pulse count, per-pulse temperatures — and it already does note-driven tuning.

Architecture is a decision list, not a model: roast level sets a baseline, then origin, altitude,
processing, freshness, and tasting-note family each apply fixed additive deltas. No formulas, no
regression, no coefficients. This is the same shape as the deterministic axis map proposed in the
bead, which is the main reason to prefer that approach over prompt-only guidance.

### Tasting-note deltas (verbatim from the article)

| Note family | Deltas |
| --- | --- |
| Fruity / Acidic | brew ratio +0.5, bloom temp +2 °C, grind finer by 4 |
| Nutty / Chocolate | brew ratio −0.5, grind coarser by 2 |
| Floral / Herbal | bloom ratio +0.5, grind coarser by 2 |
| Heavy Sweet | bloom ratio −0.5, grind finer by 2 |
| Creamy | bloom temp −2 °C |

Notes are also said to shape the pulse profile — higher initial temperatures for bright/fruity,
lower final temperatures to preserve sweetness and depth — but no magnitudes are published for that.

### The gap this confirms

The article defines rules for **five** note families. The live tool offers **eight**, adding
Earthy & Roasted, Fermented & Wine-like, and Spiced. None of those three has a published rule.

The coffee that triggered the complaint was fig / black-tea / pepper:

- fig → Fruity — covered
- black tea → Floral / Herbal / Tea — covered
- pepper → **Spiced — no rule anywhere**

So the best available prior art would have left a third of that bean's profile untuned in exactly
the way we did. Our axis set has to cover spice, earthy/roasted, and fermented explicitly rather
than inheriting the same hole. An axis that legitimately has no delta should say so in
`parameterRationale` instead of silently contributing nothing.

### Its other axes, as a cross-check on our roast-level baseline

Roast baselines:

- Light: brew ratio 17, bloom ratio 3.5, bloom 60 s, 6 pulses
- Dark: brew ratio 15, bloom ratio 1.5, bloom 40 s, 3 pulses
- Medium is the implied baseline; its numeric defaults are never stated

Pulse temperature ramps:

- Light: ascending 90 → 96 °C (≈ +1.2 °C per pulse over 6 pulses)
- Medium: flat at bloom temperature
- Dark: descending 91 → 85 °C over 3 pulses

Origin:

- East African (Ethiopia, Kenya): bloom ratio −0.5, bloom −5 s, bloom temp −3 °C, pulses −1
- Latin American (Brazil, Colombia, Guatemala): the inverse of the above
- Indonesian (Sumatra, Java): absolute override — bloom ratio set to 2.5, bloom 50 s, pulses +1

Altitude:

- High, >1500 m: brew ratio −0.5, bloom ratio +0.5, bloom +5 s, grind finer by 2
- Low, <1200 m: the inverse. No rule stated for the 1200–1500 m gap

Processing, collapsed into two buckets:

- Natural / honey / carbonic / anaerobic: bloom ratio +0.5 (floor 2.5), bloom +5 s (floor 45 s),
  pulses +1
- Washed / double fermentation / wet-hulled: bloom ratio −0.5, bloom −5 s, pulses −1
- Monsooned and pulped natural appear in the tool's dropdown but are in neither bucket

Freshness (article version): fresh 0–7 days → bloom ratio +0.5, bloom +5 s, grind finer by 4, pulse
temps −1 °C per pulse; older >20 days → the inverse, pulse temps +1 °C per pulse.

### Caveats before reusing any of those numbers

- **No citations at all.** No papers, no books, no SCA standards. Every value is the author's
  judgement, asserted in their own voice. Treat as a prior, not as evidence.
- **Article and live tool have diverged.** The article sets light-roast bloom ratio to 3.5; the tool
  states bloom ratio is capped at 1:3 for the Fellow brewer. The article uses 7/20-day freshness
  thresholds; the tool emits three fixed bands at <14 / 14–42 / >42 days. Read the article as
  documentation of intent, not as a spec for the running tool.
- No repository, no license, no API. Client-side JavaScript only; the logic itself is not published.

### One pattern worth copying

Grind is expressed as a **relative offset** from the user's usual pour-over setting, range −16 to
+16, explicitly "not calibrated grinder clicks". Grind numbers are grinder-specific, and we already
store the grinder in user settings, so a relative offset is the honest unit for us too.

## Counter-evidence: temperature is the weakest knob

Batali et al., "Brew temperature, at fixed brew strength and extraction, has little impact on the
sensory profile of drip brew coffee" — <https://pmc.ncbi.nlm.nih.gov/articles/PMC7536440/>

Tested 87 / 90 / 93 °C with TDS and percent extraction held constant by adjusting grind, brew ratio,
and flow rate; all samples served at 65 ± 1 °C. Conclusion: "brew temperature had no appreciable
impact". No significant temperature effects below four-way interactions; the single univariate
effect was nutty at 90 °C, a 1-point difference on a 100-point scale.

What did drive the sensory differences:

- **TDS dominated** — 72.2% of variance in PC1. Higher TDS → more bitter, astringent, roasted.
- **Percent extraction** was secondary. Lower PE → more sour and citrus.

Limitation: one coffee, one roast level, so roast-level interactions were not investigated.

**Implication for our delta design.** Grind and ratio are the knobs that actually move TDS and
extraction yield; temperature is the weakest lever. The ±2 °C note-driven temperature nudge is the
least defensible entry in Elvidge's set. Keep note-driven temperature deltas small, label them
heuristic, and never let a temperature change be the only thing distinguishing two recipes.

## Further sources

- **Guinard et al. 2023**, "A new Coffee Brewing Control Chart relating sensory properties and
  consumer liking to brew strength, extraction yield, and brew ratio", *Journal of Food Science*
  88:2168–2177, doi `10.1111/1750-3841.16531`, PubMed `36988107`. Peer-reviewed sensory attributes
  mapped onto TDS/EY regions — the rigorous version of what this bead hand-rolls. Acidic/fruity sits
  at the low end of both TDS and EY; balanced at moderate values. Paywalled; worth obtaining the
  full text before fixing delta magnitudes.
- **Barista Hustle Coffee Compass** — <https://www.baristahustle.com/coffee-compass/>. Maps a
  *perceived defect* to a corrective adjustment (extract more/less via grind and brew time; more or
  less coffee via brew ratio). Reactive, not predictive: this belongs to the existing `troubleshoot`
  prompt in `src/prompts.ts`, not to this bead. Recorded so the two are not conflated.
- **World Coffee Research Sensory Lexicon 2.0** —
  <https://worldcoffeeresearch.org/resources/sensory-lexicon>. 110 defined flavor, aroma, and
  texture attributes with intensity references. Use as the controlled vocabulary that roaster note
  text is normalized into, rather than inventing our own term list.
- **`9b/fellow-aiden`** — <https://github.com/9b/fellow-aiden>. Python Aiden library with a "Brew
  Studio" UI advertising AI-generated recipes. Not yet inspected; check whether its generation is
  rule-based and worth borrowing.
