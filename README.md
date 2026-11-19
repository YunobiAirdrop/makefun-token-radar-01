# LaunchLens-3 — token launch radar (token-radar-01)

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01).

A program plus a static dashboard that ranks protocols which record no
token yet by what their launch would be worth, each with an eight-step
farm plan that carries its own costs, durations and budget lines.

LaunchLens-3 replaces the previous entry's category-multiple model with
a regression fitted to the snapshot itself, after a backtest on the
snapshot's already-launched protocols showed the multiples model's
errors were mostly a wrong size law. The backtest harness lives beside
this entry (`../backtest.mjs`, `../backtest-finalists.mjs`,
`../backtest-diag.mjs` in the build folder).

## Run

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only. Outputs: `board.json`, `data.js`,
`dashboard/`, `screenshots/`, `dossier.json`.

## The model (lib/model.ts, launchlens-3)

- **A fitted regression, not multiples.** log10(launch value) is fitted
  by ridge/Huber regression on the snapshot's own trading protocols:
  an intercept, log10 TVL with a hinge at $1B, ridge-shrunk category
  offsets (lambda 10), tanh of the 7-day TVL change, and a saturating
  track-record curve. Fitted on this snapshot: the size exponent is
  about 0.47 (0.81 above $1B TVL) — value grows much slower than TVL,
  so the effective multiple falls with size instead of staying fixed.
- **Dead prints excluded.** 16 of the 144 trading protocols record a
  market cap of $0 or less. The old model read them as a 0.005
  multiple and biased every prediction low (cross-validated mean error
  −0.12); the regression fits the 128 live prints only.
- **Growth with the sign the data gives it.** The fitted growth
  coefficient is negative: a hot week compresses value at a given TVL
  (rushed-in TVL has not yet earned a token premium), where the old
  model rewarded a hot week by a fixed +0.45 tanh factor.
- **Validated in the open.** `buildRadar` cross-validates the fitted
  model against the launchlens-2 multiples model on identical folds
  (5 seeds × 5 folds, outcomes hidden per fold) and writes both
  errors into the radar's `fit` block; the dashboard states them.
  On this snapshot: median |log10 error| ≈ 0.59 vs ≈ 0.68, mean error
  ≈ 0.00 vs ≈ −0.12.
- **Explicit token_status.** Every row states `pre-token` or
  `already-trading`. The board ranks pre-token protocols only; the
  already-trading set is a separate dashboard view — and the
  regression's training set.
- **Candidacy.** A candidate records no token and is not a wrapped,
  staked, bridged, versioned or exchange product of one that trades —
  the watchlist's own exclusions, applied below its floor too, so all
  40 watchlist protocols are covered and early ones join them.
- **Deterministic.** A pure function of the snapshot bytes: two runs
  write identical output.

## Dashboard

Static, no network: board with search, category and chain filters and
four sort orders; a detail view per protocol showing the fitted
model's working and the structured farm plan; a separate
already-trading view. Views are addressable by hash
(`#detail=<slug>`, `#cat=<category>`, `#live=1`), which is how the
three screenshots were taken.
