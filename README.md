# makefun-token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/YunobiAirdrop/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchLens — a token launch radar ranking pre-token protocols by implied launch value, each with a concrete farm plan. The program reads the sealed DefiLlama snapshot, derives every category's launch multiple from the snapshot's own tokenised protocols (median market cap over TVL), then adjusts each pre-token protocol for its seven-day TVL growth, its tokenless track record and its chain reach. The board covers the whole watchlist and every other rankable pre-token protocol in the snapshot; the dashboard adds a detail view per protocol with the model's arithmetic and a seven-step farm plan, plus a live-token reference table that keeps protocols whose token already trades separate from the ones still to come.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zqdg0kc1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
