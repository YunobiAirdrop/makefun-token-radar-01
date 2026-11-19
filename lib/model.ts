// LaunchLens-2 valuation model for token-radar-01.
//
// Everything on the board is derived from the sealed snapshot itself:
//   1. Category multiples are LEARNED, not guessed. For every protocol in the
//      snapshot whose token already trades we observe mcap / TVL. The multiple
//      for a category is the median of those observations, shrunk toward the
//      global median in proportion to how few observations the category has,
//      so a category with two prints never outvotes one with forty.
//   2. Growth enters through a saturating curve. A protocol whose TVL grew
//      7% in a week and one that grew 70% do not deserve values ten times
//      apart, so change_7d passes through tanh: the factor rises quickly for
//      ordinary growth and flattens for extremes, in both directions.
//   3. Track record enters the same way. Days listed with no token recorded
//      pass through a saturating age curve: the first year matters most.
//   4. token_status is explicit on every row: "pre-token" for a protocol that
//      records no token, "already-trading" for one whose token trades. The
//      board ranks only pre-token protocols; already-trading protocols are
//      handed to the dashboard as their own separate view, never mixed in.
//
// The model is a pure function of the snapshot bytes: no clock, no random
// source, no network. Two runs over the same snapshot write the same bytes.

export interface Protocol {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface FarmStep {
  n: number;
  action: string;
  cost_usd: number;
  duration: string;
  budget_usd: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // Extra keys the gate allows: the model's working, stated on the row.
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  token_status: 'pre-token' | 'already-trading';
  watchlist: boolean;
  multiple: number;
  multiple_observations: number;
  growth_factor: number;
  age_factor: number;
  age_days: number | null;
  farm_plan: FarmStep[];
  farm_budget_usd: number;
  farm_weeks: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  symbol: string | null;
  change_7d: number | null;
  token_status: 'already-trading';
  observed_multiple: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  model: string;
  rows: BoardRow[];
  live: LiveRow[];
  categories: { category: string; multiple: number; observations: number }[];
  global_multiple: number;
  early_size: number;
  live_size: number;
  watchlist_size: number;
}

// ---------------------------------------------------------------- snapshot

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** Whole days from an ISO day to the snapshot's as_of day, or null. */
function ageDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${listedAt}T00:00:00Z`);
  const b = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ------------------------------------------------------- learned multiples

const RATIO_FLOOR = 0.005;
const RATIO_CAP = 30;
const SHRINK_K = 4;

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface LearnedMultiples {
  global: number;
  byCategory: Map<string, { multiple: number; observations: number }>;
}

/**
 * Learn mcap/TVL multiples from the protocols whose token already trades.
 * Ratios are winsorised to [0.005, 30] so one micro-cap print cannot poison
 * a category, the category figure is the median of its ratios, and that
 * median is shrunk toward the global median with weight SHRINK_K.
 */
export function learnMultiples(snapshot: Snapshot): LearnedMultiples {
  const all: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = Math.min(RATIO_CAP, Math.max(RATIO_FLOOR, p.mcap_usd / p.tvl_usd));
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = perCategory.get(key);
    if (list === undefined) perCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  all.sort((a, b) => a - b);
  const global = median(all);
  const byCategory = new Map<string, { multiple: number; observations: number }>();
  for (const [key, list] of perCategory) {
    list.sort((a, b) => a - b);
    const med = median(list);
    const multiple = (list.length * med + SHRINK_K * global) / (list.length + SHRINK_K);
    byCategory.set(key, { multiple, observations: list.length });
  }
  return { global, byCategory };
}

function multipleFor(learned: LearnedMultiples, category: string | null): { multiple: number; observations: number } {
  const hit = learned.byCategory.get(category ?? 'Uncategorised');
  if (hit !== undefined) return hit;
  return { multiple: learned.global, observations: 0 };
}

// ------------------------------------------------------------ the factors

/** Saturating growth: tanh keeps a hot week from exploding the value. */
export function growthFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + 0.45 * Math.tanh(change7d / 20);
}

/** Saturating track record: ageDays / (ageDays + 540), mapped to [0.8, 1.25]. */
export function ageFactor(days: number | null): number {
  if (days === null) return 0.95;
  return 0.8 + 0.45 * (days / (days + 540));
}

/** A small, capped reward for being live on more than one chain. */
export function chainFactor(chains: string[]): number {
  return 1 + 0.02 * Math.min(Math.max(chains.length - 1, 0), 5);
}

// ------------------------------------------------------------- candidacy

const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * A launch candidate records no token and is not a wrapped, staked, bridged
 * or exchange product of something that already trades. The same exclusions
 * the house applied to the watchlist, applied to the whole snapshot, so the
 * radar finds early protocols below the watchlist's floor as well.
 */
export function isCandidate(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name === prefix || p.name.startsWith(`${prefix} `)) return false;
  }
  return true;
}

export function tokenStatus(p: Protocol): 'pre-token' | 'already-trading' {
  return p.gecko_id === null && p.symbol === null ? 'pre-token' : 'already-trading';
}

// -------------------------------------------------------------- farm plan

interface Archetype {
  venue: string;
  deposit: string;
  activity: string;
  loop: string;
}

const ARCHETYPES: Record<string, Archetype> = {
  Dexs: {
    venue: 'its exchange interface',
    deposit: 'Provide liquidity to its busiest pair so your address holds real volume, not wash trades.',
    activity: 'Swap through the main pairs in normal sizes, the way a regular trader would.',
    loop: 'Rebalance the LP position weekly so fees keep accruing on the active range.',
  },
  Lending: {
    venue: 'its lending markets',
    deposit: 'Supply a blue-chip collateral asset to its main market and keep the position healthy.',
    activity: 'Borrow a modest amount against the supply and repay it, so both sides of the market see your address.',
    loop: 'Roll the supply-and-borrow loop monthly, never letting the health factor drift near liquidation.',
  },
  CDP: {
    venue: 'its vault interface',
    deposit: 'Open a small vault with a blue-chip collateral asset and mint its stablecoin against it.',
    activity: 'Repay and re-mint in modest cycles so the vault shows sustained, careful use.',
    loop: 'Top up collateral whenever its price drops, keeping the vault far from liquidation.',
  },
  Yield: {
    venue: 'its vaults',
    deposit: 'Deposit into its flagship vault on the main chain and hold the position.',
    activity: 'Compound the yield back into the same vault instead of withdrawing it.',
    loop: 'Rotate a slice into its newer vaults as they open, keeping the original position alive.',
  },
  'Yield Aggregator': {
    venue: 'its aggregator vaults',
    deposit: 'Deposit into its flagship vault on the main chain and hold the position.',
    activity: 'Compound the yield back into the same vault instead of withdrawing it.',
    loop: 'Rotate a slice into its newer vaults as they open, keeping the original position alive.',
  },
  Bridge: {
    venue: 'its bridge interface',
    deposit: 'Bridge a modest amount to its destination chain and keep funds working there.',
    activity: 'Bridge back and forth in normal amounts on different days, not in one burst.',
    loop: 'Repeat the route monthly with fresh amounts so the history reads as real use.',
  },
  Derivatives: {
    venue: 'its trading interface',
    deposit: 'Fund a trading account with a modest margin balance.',
    activity: 'Open and close small hedged positions so the account shows real, careful trading.',
    loop: 'Trade a few sessions each month, keeping total size small against the margin.',
  },
  RWA: {
    venue: 'its investor interface',
    deposit: 'Complete its onboarding and deposit into its flagship real-world-asset vault.',
    activity: 'Hold the position through a full yield cycle instead of exiting early.',
    loop: 'Add a small top-up each cycle so the account shows continuing commitment.',
  },
  Launchpad: {
    venue: 'its launch interface',
    deposit: 'Register and complete any staking or whitelist step it asks of participants.',
    activity: 'Take part in one live launch in a modest size, following its own rules.',
    loop: 'Stay registered for the next launch rather than leaving after the first.',
  },
  Payments: {
    venue: 'its payment interface',
    deposit: 'Fund a small balance and route a real payment through it.',
    activity: 'Make a few genuine payments on different days, in normal amounts.',
    loop: 'Keep a small working balance and use it monthly so the history stays alive.',
  },
};

const GENERIC: Archetype = {
  venue: 'its main interface',
  deposit: 'Make a first real deposit or stake through its main interface and keep it in place.',
  activity: 'Use its core product the way it is meant to be used, in normal sizes, on separate days.',
  loop: 'Repeat the core action monthly so the address history reads as a real user, not a burst.',
};

/** Position size for a farm wallet, tiered by the protocol's TVL. */
function positionUsd(tvl: number): number {
  if (tvl >= 1_000_000_000) return 1000;
  if (tvl >= 250_000_000) return 750;
  if (tvl >= 50_000_000) return 500;
  if (tvl >= 10_000_000) return 300;
  return 200;
}

function gasUsd(chains: string[]): number {
  const main = chains[0] ?? 'Ethereum';
  if (main === 'Ethereum') return 24;
  if (main === 'Bitcoin') return 12;
  return 6;
}

/**
 * An eight-step farm plan with a structured budget: every step names its
 * action, its own cost in USD, how long it takes and the budget it draws on.
 * Costs are gas and fees for a wallet on the protocol's main chain; the
 * position itself is capital the farmer keeps, stated once in the budget.
 */
export function farmPlan(p: Protocol): { steps: FarmStep[]; budget: number; weeks: number } {
  const arch = ARCHETYPES[p.category ?? ''] ?? GENERIC;
  const chain = p.chains[0] ?? 'Ethereum';
  const position = positionUsd(p.tvl_usd);
  const gas = gasUsd(p.chains);
  const steps: FarmStep[] = [
    { n: 1, action: `Research ${p.name} on ${chain}: read its docs, confirm it records no token yet, and note which addresses it rewards.`, cost_usd: 0, duration: '1 day', budget_usd: 0 },
    { n: 2, action: `Set up a fresh wallet for ${p.name} and fund it on ${chain} with the position plus a gas buffer.`, cost_usd: gas, duration: '1 day', budget_usd: position + gas * 4 },
    { n: 3, action: `Make the first deposit through ${arch.venue}: ${arch.deposit}`, cost_usd: gas, duration: '1-2 days', budget_usd: position },
    { n: 4, action: `Use the core product on ${chain}: ${arch.activity}`, cost_usd: gas, duration: '1 week', budget_usd: Math.round(position / 2) },
    { n: 5, action: `Add a second, smaller position or a second chain of ${p.name} (${p.chains.slice(0, 3).join(', ') || chain}) so the history is not one transaction.`, cost_usd: gas, duration: '1 week', budget_usd: Math.round(position / 2) },
    { n: 6, action: `Keep the position working: ${arch.loop}`, cost_usd: gas, duration: '4 weeks', budget_usd: position },
    { n: 7, action: `Join the ${p.name} community channels and any public points, quests or governance it runs, and record every step with dates.`, cost_usd: 0, duration: '2 weeks, alongside', budget_usd: 0 },
    { n: 8, action: `Review monthly: if ${p.name} announces a token, snapshot or claim, act in the first week; if nothing after 6 months, wind the position down.`, cost_usd: gas, duration: '1 day, monthly check', budget_usd: Math.round(position / 4) },
  ];
  const weeks = 10;
  return { steps, budget: position + gas * 5, weeks };
}

/** One farm step as a board string: action, cost and duration in the text. */
export function farmStepText(step: FarmStep): string {
  return `Step ${step.n}: ${step.action} Cost: about $${step.cost_usd}. Time: ${step.duration}.`;
}

// ------------------------------------------------------------------ board

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const learned = learnMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);

  const scored: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isCandidate(p)) continue;
    const { multiple, observations } = multipleFor(learned, p.category);
    const gf = growthFactor(p.change_7d);
    const days = ageDays(p.listed_at, snapshot.as_of);
    const af = ageFactor(days);
    const raw = p.tvl_usd * multiple * gf * af * chainFactor(p.chains);
    const implied = Math.min(100_000_000_000_000, Math.max(1, Math.round(raw)));
    const plan = farmPlan(p);
    scored.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: plan.steps.map(farmStepText),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      token_status: 'pre-token',
      watchlist: watch.has(p.slug),
      multiple: Math.round(multiple * 10000) / 10000,
      multiple_observations: observations,
      growth_factor: Math.round(gf * 10000) / 10000,
      age_factor: Math.round(af * 10000) / 10000,
      age_days: days,
      farm_plan: plan.steps,
      farm_budget_usd: plan.budget,
      farm_weeks: plan.weeks,
    });
  }
  // Deterministic order: value desc, then TVL desc, then slug asc.
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  scored.forEach((row, i) => {
    row.rank = i + 1;
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => tokenStatus(p) === 'already-trading' && p.mcap_usd !== null)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      symbol: p.symbol,
      change_7d: p.change_7d,
      token_status: 'already-trading' as const,
      observed_multiple: p.tvl_usd > 0 ? Math.round((p.mcap_usd! / p.tvl_usd) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 120);

  const categories = [...learned.byCategory.entries()]
    .map(([category, v]) => ({ category, multiple: Math.round(v.multiple * 10000) / 10000, observations: v.observations }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: 'launchlens-2',
    rows: scored,
    live,
    categories,
    global_multiple: Math.round(learned.global * 10000) / 10000,
    early_size: scored.filter((r) => !r.watchlist).length,
    live_size: live.length,
    watchlist_size: snapshot.watchlist.length,
  };
  return { board: scored, radar };
}

/** The first gate problem with a board, or null when the board is clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of board) {
    if (!slugs.has(row.slug)) return `row ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug}: farm_steps outside 3..12`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `${row.slug}: a farm step is ${len} characters, outside 20..600`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `ranks are not exactly 1..N`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises as rank ascends';
  }
  return null;
}

/** The dashboard's data file: one deterministic assignment, no dates. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
