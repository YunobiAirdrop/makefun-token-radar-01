// LaunchLens: a token launch radar model. One sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds every
// other rankable protocol that records no token: the early rows the radar exists to find. Every board
// row carries token_status "pre-token" so the separation is explicit in the data itself. Protocols
// whose token already trades are never ranked; they are measured separately as the live reference
// set, because their market caps are what teach the model what a launch is worth.
//
// The value model uses only the snapshot's own figures, and its centre is learned, not hardcoded:
// for each category, the launch multiple is the MEDIAN market-cap-to-TVL ratio of the protocols in
// that same category whose token already trades in this snapshot. A category with too few traded
// peers falls back to the snapshot-wide median. Each pre-token protocol is then adjusted:
//
//   implied = TVL x category multiple x growth x maturity x reach x size
//
//   growth    a saturating curve on change_7d: 1 + 0.45 x g / (50 + |g|), g clamped to [-90, 400],
//             so a hot week lifts value without a 4,000% outlier breaking the board
//   maturity  0.70 + 0.50 x sqrt(min(age_days, 1825) / 1825): years run with no token earn trust
//             on a square-root curve; a protocol with no listed date scores 0.88
//   reach     1 + 0.03 per extra chain beyond the first, capped at eight extra chains
//   size      1 up to $1B of TVL, then a gentle (1B / TVL)^0.10 compression, floored at 0.65
//
// No protocol name is ever special-cased: the same functions score every row, and the dashboard
// states the model and shows each row's arithmetic, factor by factor.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'launchlens-2';

/** How many live-token protocols the reference table carries, by market cap. */
export const LIVE_ROWS = 30;

/** One category's learned launch multiple and the traded peers it came from. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
  learned: boolean;
}

/** The model's learned constants for one snapshot: per-category multiples plus the global fallback. */
export interface LearnedModel {
  global_multiple: number;
  by_category: Map<string, CategoryMultiple>;
}

/** A farm plan's budget, summed from its own steps so the dashboard can quote it at a glance. */
export interface FarmBudget {
  capital_usd: number;
  est_fees_usd: number;
  days: number;
  est_minutes: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  confidence: number;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_factor: number;
    maturity_factor: number;
    reach_factor: number;
    size_factor: number;
  };
  farm: FarmBudget;
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row plus its farm plan. */
export interface RadarRow extends BoardRow {}

/** A live-token protocol: it already trades, so the radar shows the market's own figures for it. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl: number;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  global_multiple: number;
  category_multiples: CategoryMultiple[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_total: number;
  board_tvl_usd: number;
  median_implied_usd: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are products of a token that already trades, per the watchlist's own rule. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Names that begin with an exchange's name are that exchange's product, not a launch candidate. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol is one the board may add beyond the watchlist: pre-token and not a traded token's product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Learn the launch multiples from the snapshot itself: for every category, the median
 * market-cap-to-TVL ratio of its protocols whose token already trades. Categories with fewer
 * than three traded peers fall back to the snapshot-wide median.
 */
export function learnModel(snapshot: Snapshot): LearnedModel {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMultiple = clamp(allRatios.length > 0 ? median(allRatios) : 0.3, 0.05, 3);
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    if (ratios.length >= 3) {
      byCategory.set(category, { category, multiple: clamp(median(ratios), 0.05, 3), peers: ratios.length, learned: true });
    } else {
      byCategory.set(category, { category, multiple: globalMultiple, peers: ratios.length, learned: false });
    }
  }
  return { global_multiple: round4(globalMultiple), by_category: byCategory };
}

/** The launch multiple one protocol gets: its category's learned value, or the global fallback. */
function multipleFor(model: LearnedModel, p: SnapshotProtocol): number {
  const entry = model.by_category.get(p.category ?? 'Uncategorised');
  return entry === undefined ? model.global_multiple : entry.multiple;
}

/**
 * How complete one protocol's own record is, 0 to 100: a reported seven-day change, a listed
 * date, several chains and a category whose multiple was learned from traded peers all raise it.
 * Confidence never moves the value; it tells the reader how much record the value rests on.
 */
export function confidenceFor(p: SnapshotProtocol, model: LearnedModel): number {
  let score = 30;
  if (typeof p.change_7d === 'number' && Number.isFinite(p.change_7d)) score += 25;
  if (p.listed_at !== null) score += 20;
  if (p.chains.length >= 3) score += 10;
  else if (p.chains.length === 2) score += 6;
  else if (p.chains.length === 1) score += 3;
  const entry = model.by_category.get(p.category ?? 'Uncategorised');
  if (entry !== undefined && entry.learned) score += 15;
  else if (entry !== undefined) score += 7;
  return Math.min(100, score);
}

/** The four adjustment factors and the implied value one protocol gets under the learned model. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  model: LearnedModel,
): { implied: number; multiple: number; growthPct: number; growthFactor: number; maturityFactor: number; reachFactor: number; sizeFactor: number; age: number | null } {
  const multiple = multipleFor(model, p);
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0, -90, 400);
  const growthFactor = clamp(1 + 0.45 * (growthPct / (50 + Math.abs(growthPct))), 0.62, 1.42);
  const maturityFactor = age === null ? 0.88 : 0.7 + 0.5 * Math.sqrt(Math.min(age, 1825) / 1825);
  const reachFactor = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 8);
  const sizeFactor = p.tvl_usd > 1_000_000_000 ? Math.max(0.65, Math.pow(1_000_000_000 / p.tvl_usd, 0.1)) : 1;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthFactor * maturityFactor * reachFactor * sizeFactor));
  return { implied, multiple, growthPct, growthFactor, maturityFactor, reachFactor, sizeFactor, age };
}

/** A small deterministic hash of a slug, so farm plans vary by protocol without any randomness. */
function slugHash(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * What one on-chain action costs on a chain, in US dollars of network fees, from a small
 * per-chain table a farmer can budget with. Ethereum mainnet is the expensive outlier; most
 * rollups and alt-L1s clear for cents. Unknown chains get a mid estimate.
 */
const CHAIN_FEE_USD: Record<string, number> = {
  Ethereum: 12, Arbitrum: 0.15, Base: 0.08, Solana: 0.02, Binance: 0.3, Polygon: 0.02,
  Avalanche: 0.25, Optimism: 0.12, Tron: 1.3, Bitcoin: 2, 'Hyperliquid L1': 0.01, Sui: 0.01,
  Aptos: 0.01, Near: 0.01, Cosmos: 0.05, Linea: 0.1, Scroll: 0.1, Mantle: 0.05, Starknet: 0.05,
  zkSync: 0.08, Sonic: 0.01, Berachain: 0.05, Monad: 0.01, TON: 0.05, Cardano: 0.2, Stellar: 0.01,
};

function feeFor(chain: string): number {
  return CHAIN_FEE_USD[chain] ?? 0.4;
}

function feeText(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(2).replace(/\.?0+$/, '')}`;
}

/** How much capital one farm position needs, from the protocol's own TVL and category. */
function capitalFor(p: SnapshotProtocol): number {
  let capital = 60;
  if (p.tvl_usd >= 5_000_000_000) capital = 500;
  else if (p.tvl_usd >= 1_000_000_000) capital = 300;
  else if (p.tvl_usd >= 250_000_000) capital = 200;
  else if (p.tvl_usd >= 50_000_000) capital = 120;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('rwa')) capital = Math.max(capital, 250);
  if (c.includes('prediction')) capital = Math.max(capital, 100);
  return capital;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 75;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** The category's core position action, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('cdp')) return `Deposit $${capital} of ETH or a liquid staking token as collateral in ${n} on ${chain} and mint its stablecoin against it at under 50 per cent loan-to-value.`;
  if (c.includes('lend') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral to ${n} on ${chain} and borrow about 30 per cent against it, so the wallet holds a live two-sided lending position.`;
  if (c.includes('dex') || c.includes('amm')) return `Add $${capital} of liquidity to ${n}'s busiest stablecoin pool on ${chain}, split evenly across both assets, and keep the LP position open.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${n} and open one small delta-neutral position: long spot, short the same size on the perp.`;
  if (c.includes('basis')) return `Open the basis trade on ${n} with $${capital}: hold the spot asset and short its perpetual future for the same notional.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault') || c.includes('yield')) return `Deposit $${capital} into ${n}'s flagship vault on ${chain} and hold the vault shares in the same wallet for the whole plan.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} worth of the network asset through ${n} on ${chain} and keep the staking receipt token in the wallet.`;
  if (c.includes('bridge') || c.includes('cross')) return `Bridge $${capital} of USDC through ${n} to ${chain} and put the bridged funds to work in a pool on the far side the same day.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold it in the farming wallet, unspent.`;
  if (c.includes('rwa')) return `Complete ${n}'s KYC check, then subscribe $${capital} to its shortest-term tokenised asset on ${chain} and hold the position to term.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} for a protocol you already use and keep the policy active for the full term.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${n} and take one position in each of two liquid markets, sized under $${Math.round(capital / 4)} each.`;
  if (c.includes('launchpad') || c.includes('ido')) return `Register the wallet on ${n}, complete its whitelist or staking step, and keep $${capital} of stablecoins ready to commit.`;
  if (c.includes('index')) return `Buy $${capital} of ${n}'s main index token on ${chain} and hold it in the farming wallet.`;
  if (c.includes('leveraged')) return `Open a conservative 2x leveraged farm of $${capital} on ${n}'s main pair on ${chain}, with liquidation at least 40 per cent away.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain} through ${n}'s canonical route and make it your active wallet on that chain.`;
  return `Deposit $${capital} of USDC into ${n}'s main product on ${chain} and keep the position open for the whole plan.`;
}

/** The second qualifying action: a different verb than the core one, so the wallet's history is varied. */
function secondAction(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('cdp')) return `Repay a slice of the minted stablecoin and mint again a week later, so ${n} records two separate mint cycles from this wallet.`;
  if (c.includes('lend') || c.includes('collateral')) return `Repay the borrow in full after seven days, then borrow again at a smaller size, so ${n} records two complete borrow cycles.`;
  if (c.includes('dex') || c.includes('amm')) return `Route three swaps of $25 or more through ${n}'s own interface on ${chain}, on three different days, keeping the LP untouched.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Close the first hedge after a week and reopen it at half size, so the account shows two separate trading sessions on ${n}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault') || c.includes('yield')) return `Move a quarter of the position into a second ${n} vault, so the wallet holds two distinct vault positions at once.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim the staking rewards once and restake them through ${n}, which records a second on-chain action from the same wallet.`;
  if (c.includes('bridge') || c.includes('cross')) return `Bridge a further $40 back through ${n} in the opposite direction, so both routes appear in the wallet's history.`;
  if (c.includes('rwa')) return `Read ${n}'s term sheet and attestation page from the app and set a calendar note for the position's maturity date.`;
  return `Make one governance or community action ${n} offers, such as a vote or a quest, from the same wallet.`;
}

/**
 * A protocol's farm plan: eight steps, each concrete about the action, what it costs and how
 * long it takes, plus the budget those steps sum to. The plan is derived from the protocol's
 * own record (category, chains, TVL, age) with a deterministic per-slug variation, never from
 * a hand-written list of names.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): { steps: string[]; budget: FarmBudget } {
  const chain = chainOf(p);
  const fee = feeFor(chain);
  const light = round2(Math.max(0.01, fee * 0.5));
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const weekday = WEEKDAYS[slugHash(p.slug) % WEEKDAYS.length]!;
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const weeklyFees = round2(light * weeks);
  const totalFees = round2(fee * 5 + weeklyFees + light);
  const totalMinutes = 15 + 25 + 15 + 20 + 10 * weeks + 10 + 15 + 25;
  const steps = [
    `Set up one fresh wallet dedicated to ${p.name}; write the seed phrase on paper, never in a cloud note. Fund it with $${capital} of USDC plus fee money on ${chain}. Cost: ${feeText(fee)} network fee to fund. Time: 15 minutes, once, on day 1.`,
    `${coreAction(p, capital, chain)} Cost: the $${capital} position plus ${feeText(fee)} in fees. Time: 25 minutes to open, on day 1.`,
    `${secondAction(p, chain)} Cost: ${feeText(fee)} in fees. Time: 15 minutes, inside the first week.`,
    secondChain !== null
      ? `In week 3, extend the farm to ${secondChain}: bridge $40 through ${p.name}'s own route and repeat a small version of the core action there, so the wallet qualifies on two chains. Cost: ${feeText(fee)} plus bridge fees of about $1. Time: 25 minutes, once.`
      : `In week 3, deepen the position by a quarter (about $${Math.round(capital / 4)}) and repeat the second action, so the wallet's history is not a single deposit. Cost: the added capital plus ${feeText(fee)} in fees. Time: 15 minutes, once.`,
    `Every ${weekday} for ${hold} days, repeat one small qualifying action: a $10 top-up, a swap or a reward claim keeps the wallet visible in ${p.name}'s activity snapshots. Cost: about ${feeText(light)} a week, ${feeText(weeklyFees)} in all. Time: 10 minutes a week for ${weeks} weeks.`,
    `Once a month, open ${p.name}'s own app and check for a points, XP or season page; screenshot the wallet's standing and log the date, action and transaction hash of every session in a farm diary. Cost: ${feeText(light)} if a claim is needed, otherwise nothing. Time: 10 minutes a month.`,
    `Halfway through, at day ${Math.round(hold / 2)}, review the position: check ${p.name}'s TVL trend in its app, confirm the position still qualifies, and rebalance only if the pool or vault changed. Cost: ${feeText(fee)} if you rebalance, otherwise nothing. Time: 15 minutes, once.`,
    `From day ${hold} on, review weekly and exit in full when you decide to stop: withdraw, swap back to USDC and bridge home if needed. If ${p.name} announces a token, claim only through the link inside its official app and never pay a third party a fee to claim. Cost: ${feeText(fee)} to unwind. Time: 25 minutes to exit. Whole plan: $${capital} of capital, about ${feeText(totalFees)} of fees, ${hold} days, roughly ${(totalMinutes / 60).toFixed(1)} hours hands-on.`,
  ];
  const budget: FarmBudget = { capital_usd: capital, est_fees_usd: totalFees, days: hold, est_minutes: totalMinutes };
  return { steps: steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s)), budget };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: LearnedModel): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => {
    const plan = farmPlan(s.p, s.v.age);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.v.age,
      on_watchlist: watchlist.has(s.p.slug),
      token_status: 'pre-token' as const,
      confidence: confidenceFor(s.p, model),
      implied_value_usd: s.v.implied,
      model: {
        category_multiple: round4(s.v.multiple),
        growth_pct: round4(s.v.growthPct),
        growth_factor: round4(s.v.growthFactor),
        maturity_factor: round4(s.v.maturityFactor),
        reach_factor: round4(s.v.reachFactor),
        size_factor: round4(s.v.sizeFactor),
      },
      farm: plan.budget,
      farm_steps: plan.steps,
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's reference table. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      mcap_tvl: round4(p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : 0),
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = learnModel(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const liveTotal = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  const early = board.filter((r) => !r.on_watchlist).length;
  const categoryMultiples = [...model.by_category.values()].sort((a, b) => (a.category < b.category ? -1 : 1));
  const impliedSorted = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_multiple: model.global_multiple,
    category_multiples: categoryMultiples,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    live_total: liveTotal,
    board_tvl_usd: board.reduce((sum, r) => sum + r.tvl_usd, 0),
    median_implied_usd: impliedSorted.length > 0 ? impliedSorted[Math.floor(impliedSorted.length / 2)]! : 0,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${byRank[i]!.rank} outranks rank ${byRank[i - 1]!.rank} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
