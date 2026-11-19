# LaunchLens-2 — token launch radar (token-radar-01)

A program plus a static dashboard that ranks protocols which record no
token yet by what their launch would be worth, each with an eight-step
farm plan that carries its own costs, durations and budget lines.

## Run

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only. Outputs: `board.json`, `data.js`,
`dashboard/`, `screenshots/`, `dossier.json`.

## The model (lib/model.ts, launchlens-2)

- **Learned multiples.** For every snapshot protocol whose token already
  trades, observe mcap/TVL. A category's multiple is the median of its
  observations (winsorised), shrunk toward the global median by sample
  size. No multiple is a hand-picked constant.
- **Saturating growth.** The 7-day TVL change passes through tanh, so
  extreme weeks flatten instead of exploding the value.
- **Saturating track record.** Days listed with no token recorded pass
  through an age curve with the same property.
- **Explicit token_status.** Every row states `pre-token` or
  `already-trading`. The board ranks pre-token protocols only; the
  already-trading set is a separate dashboard view — and the data the
  multiples are learned from.
- **Candidacy.** A candidate records no token and is not a wrapped,
  staked, bridged, versioned or exchange product of one that trades —
  the watchlist's own exclusions, applied below its floor too, so all
  40 watchlist protocols are covered and early ones join them.
- **Deterministic.** A pure function of the snapshot bytes: two runs
  write identical output.

## Dashboard

Static, no network: board with search, category and chain filters and
four sort orders; a detail view per protocol showing the model's
working and the structured farm plan; a separate already-trading view.
Views are addressable by hash (`#detail=<slug>`, `#cat=<category>`,
`#live=1`), which is how the three screenshots were taken.
