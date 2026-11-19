# makefun-token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchLens — a token launch radar ranking pre-token protocols by implied launch value, each with a concrete farm plan. The program reads the sealed DefiLlama snapshot, derives every category's launch multiple from the snapshot's own tokenised protocols (median market cap over TVL), then adjusts each pre-token protocol for its seven-day TVL growth (a saturating curve), its tokenless track record (a square-root maturity curve), its chain reach and its TVL scale. Every board row is explicitly marked pre-token. The board covers the whole watchlist and every other rankable pre-token protocol in the snapshot; the dashboard adds a sortable, filterable board, a detail view per protocol with the model's factor-by-factor arithmetic and an eight-step farm plan with a summed budget (capital, estimated fees, days, hands-on time), plus a separate already-trading view that keeps protocols whose token already trades off the ranked board.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zqdg0kc1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
