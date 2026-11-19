// LaunchLens-3 valuation model for token-radar-01.
//
// The value model is a regression fitted to the snapshot itself, at run
// time, on the protocols whose token already trades:
//
//   log10(launch value) = intercept
//                       + beta * (log10(TVL) - mean log10(TVL))
//                       + category offset (ridge-shrunk toward zero)
//                       + growth coefficient * tanh(change_7d / 20)
//                       + age coefficient * (age curve - 1/3)
//                       + hinge coefficient * max(0, log10(TVL) - 9)
//
// What the fit learns from this snapshot's 128 usable trading protocols
// (the 16 that record a market cap of $0 or less are dead prints: they
// carry no launch value, so they are excluded from the fit — including
// them biased every prediction down by about a fifth of a decade):
//   - Value grows much slower than TVL: the size exponent is about 0.47,
//     steepening to about 0.81 above $1B of TVL (the hinge). A raw
//     mcap/TVL multiple assumes an exponent of exactly 1, which is why
//     the old multiples model overvalued large protocols and undervalued
//     small ones by half a decade at each end.
//   - A hot week COMPRESSES value at a given TVL (the growth coefficient
//     is negative): TVL that just rushed in has not yet earned a token
//     premium. Growth enters the model, with the sign the data gives it.
//   - Track record (days listed, no token recorded) enters through the
//     same saturating age curve as before; its fitted weight is small.
//
// The fit is ridge on the category offsets (lambda 10) and Huber-robust
// (12 IRLS rounds), so one wild print — the snapshot holds a 400x
// mcap/TVL — cannot bend the line. It is validated honestly inside
// buildRadar: 5 seeds x 5 folds of cross-validation over the trading
// protocols, each fold's outcomes hidden while its model is fitted,
// scored against the launchlens-2 multiples model fitted the same way.
// On this snapshot the regression's cross-validated median |log10 error|
// is about 0.59 against the multiples model's 0.68, and its mean error
// is about zero where the multiples model runs -0.12 (systematically
// low). Those fitted diagnostics are written into the radar's `fit`
// block and shown on the dashboard, so the claim can be checked.
//
// token_status is explicit on every row: "pre-token" for a protocol that
// records no token, "already-trading" for one whose token trades. The
// board ranks only pre-token protocols; already-trading protocols are
// handed to the dashboard as their own separate view, never mixed in.
//
// The model is a pure function of the snapshot bytes: no clock, no
// random source, no network. Two runs over the same snapshot write the
// same bytes.

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

export interface FitInfo {
  trained_on: number;
  excluded_dead_prints: number;
  size_exponent: number;
  size_exponent_above_1b: number;
  growth_coefficient: number;
  age_coefficient: number;
  cv_median_abs_log10_error: number;
  cv_legacy_median_abs_log10_error: number;
  cv_mean_log10_error: number;
  cv_legacy_mean_log10_error: number;
  cv_folds: string;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  model: string;
  rows: BoardRow[];
  live: LiveRow[];
  categories: { category: string; multiple: number; observations: number }[];
  global_multiple: number;
  fit: FitInfo;
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

// -------------------------------------------------------------- features

/** The model's per-protocol features, all read off the snapshot's fields. */
interface Features {
  lt: number;
  g: number;
  a: number;
  hinge: number;
}

function featuresOf(p: Protocol, asOf: string): Features {
  const days = ageDays(p.listed_at, asOf);
  const lt = Math.log10(Math.max(1, p.tvl_usd));
  return {
    lt,
    g: p.change_7d === null ? 0 : Math.tanh(p.change_7d / 20),
    // Saturating age curve; an unreported age sits at 1/3, the point the
    // age term is centred on, so it moves the prediction by nothing.
    a: days === null ? 1 / 3 : days / (days + 540),
    hinge: Math.max(0, lt - 9),
  };
}

// ------------------------------------------------- the regression (fit)

const CAT_LAMBDA = 10;
const HUBER_ROUNDS = 12;

/** Gaussian elimination with partial pivoting; solves A x = b. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const swap = M[col]!;
    M[col] = M[piv]!;
    M[piv] = swap;
    const d = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j] = M[col]![j]! / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r]![j] = M[r]![j]! - f * M[col]![j]!;
    }
  }
  return M.map((row) => row[n]!);
}

export interface FittedModel {
  intercept: number;
  beta: number;
  growth: number;
  age: number;
  hinge: number;
  ltMean: number;
  catOffset: Map<string, number>;
  catCount: Map<string, number>;
  trainedOn: number;
}

interface TrainRow {
  p: Protocol;
  f: Features;
  y: number;
}

function design(row: TrainRow | { p: Protocol; f: Features }, cats: string[], ltMean: number): number[] {
  const v = [1, row.f.lt - ltMean];
  for (const c of cats) v.push((row.p.category ?? 'Uncategorised') === c ? 1 : 0);
  v.push(row.f.g, row.f.a - 1 / 3, row.f.hinge);
  return v;
}

/**
 * Fit the launchlens-3 regression on the given training rows (already
 * restricted to usable trading protocols). Ridge penalty CAT_LAMBDA on
 * the category offsets only; Huber IRLS so wild prints lose their vote.
 */
export function fitModel(rows: TrainRow[]): FittedModel {
  const cats = [...new Set(rows.map((r) => r.p.category ?? 'Uncategorised'))].sort();
  const ltMean = rows.reduce((s, r) => s + r.f.lt, 0) / rows.length;
  const X = rows.map((r) => design(r, cats, ltMean));
  const d = X[0]!.length;
  const tail = 2 + cats.length; // first penalised-free tail index layout: [0]=1, [1]=lt, [2..2+cats)=cats, then g, a, hinge
  let w: number[] | null = null;
  let beta: number[] = new Array(d).fill(0);
  for (let round = 0; round < HUBER_ROUNDS; round++) {
    const A: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
    const b: number[] = new Array(d).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const wi = w === null ? 1 : w[i]!;
      const xi = X[i]!;
      for (let r = 0; r < d; r++) {
        b[r] = b[r]! + wi * xi[r]! * rows[i]!.y;
        for (let c = 0; c < d; c++) A[r]![c] = A[r]![c]! + wi * xi[r]! * xi[c]!;
      }
    }
    for (let i = 2; i < tail; i++) A[i]![i] = A[i]![i]! + CAT_LAMBDA;
    beta = solveLinear(A, b);
    const res = rows.map((r, i) => r.y - X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0));
    const sorted = res.map(Math.abs).sort((x, y) => x - y);
    const sigma = Math.max(0.05, 1.4826 * sorted[Math.floor(sorted.length / 2)]!);
    const k = 1.345 * sigma;
    w = res.map((r) => (Math.abs(r) <= k ? 1 : k / Math.abs(r)));
  }
  const catOffset = new Map<string, number>();
  const catCount = new Map<string, number>();
  cats.forEach((c, i) => catOffset.set(c, beta[2 + i]!));
  for (const r of rows) {
    const key = r.p.category ?? 'Uncategorised';
    catCount.set(key, (catCount.get(key) ?? 0) + 1);
  }
  return {
    intercept: beta[0]!,
    beta: beta[1]!,
    growth: beta[tail]!,
    age: beta[tail + 1]!,
    hinge: beta[tail + 2]!,
    ltMean,
    catOffset,
    catCount,
    trainedOn: rows.length,
  };
}

/** The fitted model's log10 value for a protocol, and its parts. */
export function predictLog(model: FittedModel, p: Protocol, asOf: string): { logv: number; baseLogv: number; growthFactor: number; ageFactor: number } {
  const f = featuresOf(p, asOf);
  const off = model.catOffset.get(p.category ?? 'Uncategorised') ?? 0;
  const baseLogv = model.intercept + model.beta * (f.lt - model.ltMean) + off + model.hinge * f.hinge;
  const growthFactor = Math.pow(10, model.growth * f.g);
  const ageFactor = Math.pow(10, model.age * (f.a - 1 / 3));
  return { logv: baseLogv + model.growth * f.g + model.age * (f.a - 1 / 3), baseLogv, growthFactor, ageFactor };
}

/** Training rows for the regression: trading protocols with a live print. */
function regressionRows(snapshot: Snapshot): TrainRow[] {
  const rows: TrainRow[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    rows.push({ p, f: featuresOf(p, snapshot.as_of), y: Math.log10(p.mcap_usd) });
  }
  return rows;
}

// --------------------------------------- the launchlens-2 baseline (CV)
// The previous model, kept so buildRadar can cross-validate the new one
// against it on identical folds: per-category median mcap/TVL multiples
// (winsorised to [0.005, 30], shrunk to the global median with k = 4),
// a +0.45 tanh growth factor, a 0.8..1.25 age factor, a per-chain bonus,
// fitted on every trading protocol including the dead $0 prints, which
// it reads as a 0.005 multiple.

const RATIO_FLOOR = 0.005;
const RATIO_CAP = 30;
const SHRINK_K = 4;

function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function legacyPredict(train: Protocol[], p: Protocol, asOf: string): number {
  const all: number[] = [];
  const per = new Map<string, number[]>();
  for (const q of train) {
    if (q.mcap_usd === null || q.tvl_usd <= 0) continue;
    const r = Math.min(RATIO_CAP, Math.max(RATIO_FLOOR, q.mcap_usd / q.tvl_usd));
    all.push(r);
    const key = q.category ?? 'Uncategorised';
    const list = per.get(key);
    if (list === undefined) per.set(key, [r]);
    else list.push(r);
  }
  all.sort((a, b) => a - b);
  const glob = medianOf(all);
  let mult = glob;
  const list = per.get(p.category ?? 'Uncategorised');
  if (list !== undefined) {
    list.sort((a, b) => a - b);
    mult = (list.length * medianOf(list) + SHRINK_K * glob) / (list.length + SHRINK_K);
  }
  const gf = p.change_7d === null ? 1 : 1 + 0.45 * Math.tanh(p.change_7d / 20);
  const days = ageDays(p.listed_at, asOf);
  const af = days === null ? 0.95 : 0.8 + 0.45 * (days / (days + 540));
  const cf = 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  return Math.log10(p.tvl_usd * mult * gf * af * cf);
}

/** Deterministic fold hash (FNV-1a over "seed:slug"), as in the backtest. */
function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface CvResult {
  modelMedian: number;
  modelMean: number;
  legacyMedian: number;
  legacyMean: number;
}

/**
 * 5 seeds x 5 folds over the snapshot's trading protocols. Each fold's
 * models are fitted without the fold's protocols and scored on them;
 * only protocols with a live print are scored (a $0 print has no log).
 */
export function crossValidate(snapshot: Snapshot): CvResult {
  const launched = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const scored = launched.filter((p) => p.mcap_usd! > 0);
  const modelErr: number[] = [];
  const legacyErr: number[] = [];
  for (let seed = 0; seed < 5; seed++) {
    const folds = launched.map((p) => fnv(`${seed}:${p.slug}`) % 5);
    for (let f = 0; f < 5; f++) {
      const trainLaunched = launched.filter((_, i) => folds[i] !== f);
      const trainRows: TrainRow[] = trainLaunched
        .filter((p) => p.mcap_usd! > 0)
        .map((p) => ({ p, f: featuresOf(p, snapshot.as_of), y: Math.log10(p.mcap_usd!) }));
      const model = fitModel(trainRows);
      for (const p of scored) {
        if (folds[launched.indexOf(p)] !== f) continue;
        const y = Math.log10(p.mcap_usd!);
        modelErr.push(predictLog(model, p, snapshot.as_of).logv - y);
        legacyErr.push(legacyPredict(trainLaunched, p, snapshot.as_of) - y);
      }
    }
  }
  const med = (errs: number[]) => medianOf(errs.map(Math.abs).sort((a, b) => a - b));
  const mean = (errs: number[]) => errs.reduce((s, e) => s + e, 0) / errs.length;
  return { modelMedian: med(modelErr), modelMean: mean(modelErr), legacyMedian: med(legacyErr), legacyMean: mean(legacyErr) };
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

const REF_TVL = 100_000_000; // category multiples are quoted at $100M TVL

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const rows = regressionRows(snapshot);
  const model = fitModel(rows);
  const cv = crossValidate(snapshot);
  const launchedCount = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0).length;
  const watch = new Set(snapshot.watchlist);

  const scored: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isCandidate(p)) continue;
    const pred = predictLog(model, p, snapshot.as_of);
    const implied = Math.min(100_000_000_000_000, Math.max(1, Math.round(Math.pow(10, pred.logv))));
    const base = Math.pow(10, pred.baseLogv);
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
      multiple: Math.round((base / Math.max(1, p.tvl_usd)) * 10000) / 10000,
      multiple_observations: model.catCount.get(p.category ?? 'Uncategorised') ?? 0,
      growth_factor: Math.round(pred.growthFactor * 10000) / 10000,
      age_factor: Math.round(pred.ageFactor * 10000) / 10000,
      age_days: ageDays(p.listed_at, snapshot.as_of),
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

  // Category multiples quoted at the reference TVL: what the fitted model
  // implies for a protocol of that category at $100M TVL, before the
  // growth and track-record terms move it.
  const refLog = Math.log10(REF_TVL);
  const categories = [...model.catOffset.entries()]
    .map(([category, off]) => ({
      category,
      multiple: Math.round((Math.pow(10, model.intercept + model.beta * (refLog - model.ltMean) + off) / REF_TVL) * 10000) / 10000,
      observations: model.catCount.get(category) ?? 0,
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  const ratios = rows.map((r) => r.p.mcap_usd! / r.p.tvl_usd).sort((a, b) => a - b);
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const round4 = (x: number) => Math.round(x * 10000) / 10000;
  const fit: FitInfo = {
    trained_on: model.trainedOn,
    excluded_dead_prints: launchedCount - model.trainedOn,
    size_exponent: round3(model.beta),
    size_exponent_above_1b: round3(model.beta + model.hinge),
    growth_coefficient: round3(model.growth),
    age_coefficient: round3(model.age),
    cv_median_abs_log10_error: round4(cv.modelMedian),
    cv_legacy_median_abs_log10_error: round4(cv.legacyMedian),
    cv_mean_log10_error: round4(cv.modelMean),
    cv_legacy_mean_log10_error: round4(cv.legacyMean),
    cv_folds: '5 seeds x 5 folds',
  };

  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: 'launchlens-3',
    rows: scored,
    live,
    categories,
    global_multiple: Math.round(medianOf(ratios) * 10000) / 10000,
    fit,
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
