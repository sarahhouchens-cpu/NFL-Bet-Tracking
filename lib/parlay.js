/**
 * Builds the tickets for the value board.
 *
 * The brief is fixed: a $5 stake that returns at least $100. That is a decimal
 * price of 20 or longer — about +1900 — and no single NFL player prop is priced
 * anywhere near that without being a bet you would not want. So the board is
 * built from parlays, and the whole problem becomes choosing which combinations
 * are worth the length.
 *
 * Two kinds of ticket come out of this, and the difference is not cosmetic:
 *
 *   spread — one leg per game. The legs really are independent, so multiplying
 *            their prices gives the price a book will actually offer you.
 *   stack  — several legs from one game, chosen because they hit together. The
 *            model prices these using the correlation model, but every
 *            sportsbook reprices same-game parlays itself, so the payout shown
 *            is an estimate and the slip will differ.
 *
 * Presenting those two as if they were the same thing would be the single most
 * misleading thing this board could do, so they are built and labelled apart.
 */

import {
  americanToDecimal,
  parlayDecimal,
  payout,
  expectedValue,
  isValidAmerican,
} from './odds.js';
import { correlationAdjustment, describeCorrelation } from './correlation.js';
import { BANNED_FROM_TICKETS, PLAYER_MARKETS } from './markets.js';

export const STAKE = 5;

/**
 * The payout floor, straight from the brief.
 *
 * There is no ceiling. A ticket returning $600 is not worse than one returning
 * $110 — it is longer, and the bands below make sure the board shows both
 * rather than filling up with lottery tickets.
 */
export const MIN_PAYOUT = 100;
export const MIN_DECIMAL = MIN_PAYOUT / STAKE;

export const LEG_COUNT = { min: 3, max: 6 };

/**
 * Payout bands, used to keep the board varied.
 *
 * With no ceiling, ranking purely by expected value pushes every slot toward
 * the longest tickets: the model's disagreements with the book compound across
 * legs, so more legs means more apparent edge. Left alone the board becomes six
 * lottery tickets. Capping how many results come from any one band keeps a
 * shorter, likelier ticket next to a long shot.
 */
export const PAYOUT_BANDS = [
  { name: 'short', min: 100, max: 200 },
  { name: 'medium', min: 200, max: 500 },
  { name: 'long', min: 500, max: Infinity },
];

export function payoutBand(total) {
  return PAYOUT_BANDS.find((b) => total >= b.min && total < b.max)?.name ?? 'long';
}

/**
 * Widest edge a leg may claim before it is treated as an error rather than an
 * opportunity.
 *
 * NFL player props are liquid. A genuine edge against a consensus line is a
 * couple of points; a twenty-point one nearly always means the model and the
 * book are pricing different things — a stale line, a player who is out, or a
 * market this code has mapped wrongly. Those are exactly the legs that look
 * most attractive to an expected-value sort, which is why they are excluded
 * rather than trusted.
 */
export const EDGE_SANITY_LIMIT = 12;

/**
 * Per-leg haircut applied while the model is unproven.
 *
 * Model error compounds with leg count. If every leg's probability is overstated
 * by a factor f, an n-leg ticket is overstated by f^n — so expected value
 * computed on raw numbers flatters long tickets specifically, which is exactly
 * backwards: the more legs a ticket has, the less its probability should be
 * trusted. This discounts each leg by an amount that fades as results
 * accumulate, so long tickets are penalised hardest while the model has nothing
 * to show for itself and the penalty disappears once it does.
 */
export const MAX_LEG_HAIRCUT = 0.07;

export function confidenceAdjusted(probability, legCount, confidence = 0) {
  const c = Math.min(1, Math.max(0, confidence));
  const haircut = MAX_LEG_HAIRCUT * (1 - c);
  return probability * (1 - haircut) ** legCount;
}

/** How many candidates to combine, and how they earn their place. */
const CANDIDATE_POOL = { byEdge: 14, byPrice: 6 };

/**
 * Reject a candidate leg that could never belong on a ticket.
 *
 * The price floor is doing real work. A leg at -300 contributes almost nothing
 * to the payout but a full share of the risk, so a ticket needs many more of
 * them to clear $100 — and every extra leg is another chance to lose. Requiring
 * each leg to pay its way keeps tickets short.
 */
export function isEligibleLeg(leg, options = {}) {
  const { minAmerican = -250, edgeLimit = EDGE_SANITY_LIMIT } = options;

  if (BANNED_FROM_TICKETS.has(leg.marketKey)) return false;
  if (!PLAYER_MARKETS[leg.marketKey]) return false;
  if (!isValidAmerican(leg.americanOdds)) return false;
  if (Number(leg.americanOdds) < minAmerican) return false;
  if (!Number.isFinite(leg.modelProbability) || leg.modelProbability <= 0.02) return false;
  // A leg the model thinks is nearly certain is nearly certainly mismapped.
  if (leg.modelProbability > 0.97) return false;
  if (Number.isFinite(leg.edge) && Math.abs(leg.edge) > edgeLimit) return false;
  return true;
}

/**
 * Check a fully-assembled ticket against the structural rules.
 *
 * `maxPerGame` is what separates the two ticket styles: 1 forces every leg into
 * a different game and makes the quoted price real, while a higher number
 * allows a deliberate same-game stack.
 */
export function validateTicket(legs, options = {}) {
  const { maxPerGame = 1, maxTdLegs = 2, maxPerMarket = 3 } = options;

  if (legs.length < LEG_COUNT.min || legs.length > LEG_COUNT.max) return false;

  // One player, one leg. Two legs on the same player are the same opinion
  // twice, and most books will not take them on a cross-game ticket anyway.
  const players = new Set(legs.map((l) => l.playerId));
  if (players.size !== legs.length) return false;

  const perGame = new Map();
  for (const leg of legs) perGame.set(leg.gameId, (perGame.get(leg.gameId) ?? 0) + 1);
  if ([...perGame.values()].some((count) => count > maxPerGame)) return false;

  // Touchdown props are the longest and loosest prices on the board. A ticket
  // built mostly from them is a lottery ticket wearing a model's clothes.
  const tdLegs = legs.filter((l) => l.stat === 'anytimeTd').length;
  if (tdLegs > maxTdLegs) return false;

  // Six passing-yard overs is not six bets, it is one bet on a high-scoring
  // week bought six times. Whenever the model develops a systematic lean on a
  // market — and a model built from ratios will — an expected-value sort finds
  // it and fills the whole ticket with it, so the ticket has to be stopped from
  // concentrating regardless of why the lean is there.
  const perMarket = new Map();
  for (const leg of legs) perMarket.set(leg.stat, (perMarket.get(leg.stat) ?? 0) + 1);
  if ([...perMarket.values()].some((count) => count > maxPerMarket)) return false;

  return true;
}

function* combinations(items, size, start = 0, current = []) {
  if (current.length === size) {
    yield current;
    return;
  }
  // Stop descending once too few items remain to finish a combination.
  for (let i = start; i <= items.length - (size - current.length); i++) {
    yield* combinations(items, size, i + 1, [...current, items[i]]);
  }
}

/**
 * Price one assembled ticket.
 *
 * The probability travels through three stages, and each is kept so the board
 * can show its work: the raw product of the legs, the same number adjusted for
 * how the legs move together, and finally the confidence haircut. Expected
 * value is computed on the last of those, because that is the only one that
 * accounts for the model being new.
 */
export function priceTicket(legs, options = {}) {
  const { stake = STAKE, confidence = 0, correlationStrength = 0.5 } = options;

  const decimal = parlayDecimal(legs);
  const totalReturn = payout(stake, decimal);

  const independent = legs.reduce((acc, leg) => acc * leg.modelProbability, 1);
  const adjustment = correlationAdjustment(legs, correlationStrength);
  const correlated = Math.min(0.99, independent * adjustment);
  const adjusted = confidenceAdjusted(correlated, legs.length, confidence);

  const games = new Set(legs.map((l) => l.gameId));

  return {
    legs,
    decimal,
    americanOdds: decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1)),
    stake,
    payout: totalReturn,
    profit: totalReturn - stake,
    independentProbability: independent,
    correlationAdjustment: adjustment,
    probability: correlated,
    adjustedProbability: adjusted,
    expectedValue: expectedValue(stake, decimal, adjusted),
    rawExpectedValue: expectedValue(stake, decimal, independent),
    band: payoutBand(totalReturn),
    style: games.size === legs.length ? 'spread' : 'stack',
    gameCount: games.size,
    note: describeCorrelation(legs),
  };
}

/**
 * Score and rank every legal ticket the candidate pool can produce.
 *
 * Ranked by expected value rather than raw probability: the likeliest ticket
 * over $100 is not necessarily the best-priced one, and the entire point of
 * comparing a model against a book is to find where the price is soft.
 */
export function buildTickets(candidates, options = {}) {
  const {
    stake = STAKE,
    minPayout = MIN_PAYOUT,
    maxPayout = Infinity,
    limit = 6,
    maxPerGame = 1,
    maxLegRepeat = 2,
    maxPerBand = 3,
    confidence = 0,
    correlationStrength = 0.5,
    guaranteeShortest = true,
  } = options;

  const eligible = candidates.filter((leg) => isEligibleLeg(leg, options));

  // Legs with a measured edge, best first. An unmeasured edge sorts last here
  // but is not thereby excluded — the price slice below picks those up.
  //
  // This matters: a touchdown prop often has no "no" side posted, so it cannot
  // be devigged and its edge is null. Treating null as zero would sort every
  // unmeasured leg below every measured positive one, and the pool would fill
  // with short favourites that no three-leg ticket could ever stretch to $100.
  const byEdge = [...eligible]
    .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity) || b.modelProbability - a.modelProbability)
    .slice(0, CANDIDATE_POOL.byEdge);

  const chosenIds = new Set(byEdge.map((l) => legKey(l)));
  const byPrice = [...eligible]
    .filter((l) => !chosenIds.has(legKey(l)))
    .sort((a, b) => americanToDecimal(b.americanOdds) - americanToDecimal(a.americanOdds))
    .slice(0, CANDIDATE_POOL.byPrice);

  const pool = [...byEdge, ...byPrice];

  const tickets = [];
  for (let size = LEG_COUNT.min; size <= LEG_COUNT.max; size++) {
    for (const legs of combinations(pool, size)) {
      if (!validateTicket(legs, { ...options, maxPerGame })) continue;

      const decimal = parlayDecimal(legs);
      const totalReturn = payout(stake, decimal);
      if (totalReturn < minPayout || totalReturn > maxPayout) continue;

      tickets.push(priceTicket(legs, { stake, confidence, correlationStrength }));
    }
  }

  tickets.sort((a, b) => b.expectedValue - a.expectedValue || b.probability - a.probability);

  // Ranking purely by expected value returns near-duplicates: the two or three
  // best-priced legs turn up on every ticket and the board reads as one bet
  // wearing different hats. Cap how often any single leg may reappear, and how
  // many tickets may come from one payout band, so the board offers genuinely
  // different ways to play the week.
  const used = new Map();
  const perBand = new Map();
  const chosen = [];
  for (const ticket of tickets) {
    if (chosen.length >= limit) break;
    if ((perBand.get(ticket.band) ?? 0) >= maxPerBand) continue;

    const keys = ticket.legs.map(legKey);
    if (keys.some((k) => (used.get(k) ?? 0) >= maxLegRepeat)) continue;

    for (const k of keys) used.set(k, (used.get(k) ?? 0) + 1);
    perBand.set(ticket.band, (perBand.get(ticket.band) ?? 0) + 1);
    chosen.push(ticket);
  }

  // Always offer the shortest legal ticket. Even after the haircut, expected
  // value can favour long tickets across the board, and a board of six-leg
  // lottery tickets with no three-leg alternative is not a real choice.
  if (guaranteeShortest && chosen.length && !chosen.some((t) => t.legs.length === LEG_COUNT.min)) {
    const shortest = tickets.find((t) => t.legs.length === LEG_COUNT.min);
    if (shortest) {
      chosen[chosen.length - 1] = shortest;
      chosen.sort((a, b) => b.expectedValue - a.expectedValue);
    }
  }

  // If the caps leave fewer than `limit` genuinely distinct tickets, return the
  // shorter list. Padding it with the near-duplicates just rejected would undo
  // the point, and would also break the expected-value ordering by appending
  // higher-value tickets behind lower ones.
  return chosen;
}

/**
 * Build the same-game stacks, which are a different bet with different rules.
 *
 * Restricted to one game at a time so the correlation model is only ever asked
 * about pairs it actually has an opinion on, and capped hard on length: a
 * six-leg same-game parlay is priced by the book off its own correlation model,
 * and the gap between that and this one widens with every leg.
 */
export function buildStacks(candidates, options = {}) {
  const { limit = 4, perGameLimit = 1 } = options;

  const byGame = new Map();
  for (const leg of candidates) {
    if (!leg.gameId) continue;
    if (!byGame.has(leg.gameId)) byGame.set(leg.gameId, []);
    byGame.get(leg.gameId).push(leg);
  }

  const stacks = [];
  for (const legs of byGame.values()) {
    if (legs.length < LEG_COUNT.min) continue;
    const built = buildTickets(legs, {
      ...options,
      maxPerGame: LEG_COUNT.max,
      limit: perGameLimit,
      maxPerBand: perGameLimit,
      guaranteeShortest: false,
    });
    stacks.push(...built);
  }

  stacks.sort((a, b) => b.expectedValue - a.expectedValue);
  return stacks.slice(0, limit);
}

export function legKey(leg) {
  return `${leg.playerId}|${leg.marketKey}|${leg.line ?? 'y'}`;
}

/** One-line description of a leg, the way it would read on a slip. */
export function describeLeg(leg) {
  const spec = PLAYER_MARKETS[leg.marketKey];
  const label = spec?.label ?? leg.marketKey;
  if (leg.line == null) return `${leg.playerName} ${label}`;
  return `${leg.playerName} over ${leg.line} ${label}`;
}
