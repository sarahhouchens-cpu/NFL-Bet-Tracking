/**
 * Turns a book's posted lines into player projections.
 *
 * The premise: a sportsbook's prop line is the sharpest public forecast of a
 * player's week that exists. It already contains the injury report, the
 * weather, the opponent's scheme and whatever the beat writer said on Friday.
 * Rebuilding that from season averages would be strictly worse, so this reads
 * the market rather than competing with it — and then looks for the places
 * where one book's price disagrees with the consensus it implies.
 *
 * Everything downstream — the value board and both DraftKings lineup styles —
 * is computed from the projections this module produces.
 */

import { americanToDecimal, devig, devigMultiway, impliedProbability, isValidAmerican } from './odds.js';
import { impliedMean, impliedSd, percentile, probabilityOver, expectedTouchdowns, normalQuantile } from './distribution.js';
import { projectedPoints } from './scoring.js';
import { DEFAULT_SITE } from './sites.js';
import { normalizeName, PLAYER_MARKETS } from './markets.js';

/**
 * Quantiles that define a player's range of outcomes.
 *
 * The floor is what a cash lineup is built on and the ceiling is what a
 * tournament lineup is built on, so these two numbers are the entire
 * difference between the two lineup styles further down.
 */
export const FLOOR_QUANTILE = 0.2;
export const CEILING_QUANTILE = 0.85;

/**
 * How a player's touchdowns split between rushing and receiving.
 *
 * An anytime-touchdown price says a player will score; it does not say how, and
 * the two are worth the same six points, so this only matters for keeping the
 * stat line coherent when it is displayed.
 */
const TD_SPLIT = {
  QB: { rush: 1, rec: 0 },
  RB: { rush: 0.8, rec: 0.2 },
  WR: { rush: 0.05, rec: 0.95 },
  TE: { rush: 0, rec: 1 },
  K: { rush: 0, rec: 0 },
  DST: { rush: 0, rec: 0 },
};

/**
 * Fair probability of the "yes" side of a two-sided quote.
 *
 * Without the other side there is no way to strip the vig. Rather than guess,
 * this falls back to the raw implied probability and flags it, so anything
 * built on an un-devigged number can say so instead of quietly claiming an edge
 * against a price that still has the book's margin in it.
 */
export function fairProbability(quote) {
  const yes = americanToDecimal(quote.americanOdds);
  if (!isValidAmerican(quote.oppositeAmericanOdds)) {
    return { probability: impliedProbability(yes), devigged: false };
  }
  const [fair] = devig([yes, americanToDecimal(quote.oppositeAmericanOdds)]);
  return { probability: fair, devigged: true };
}

/**
 * Infer what a player is from the markets a book posted for them.
 *
 * Books do not publish positions, and the alternative — a name-to-position
 * table checked into the repo — goes stale the moment someone changes team.
 * What a player is priced for is a reliable signal: only quarterbacks get
 * passing-yard lines, and only backs get carries without receptions.
 */
export function inferPosition(stats) {
  if (stats.has('kickingPoints')) return 'K';
  if (stats.has('passYards') || stats.has('passAttempts')) return 'QB';

  const rushYards = stats.get('rushYards') ?? 0;
  const recYards = stats.get('recYards') ?? 0;

  // Backs are the players books post rushing lines for. A receiver occasionally
  // gets one on a jet sweep, so the split is by which yardage dominates rather
  // than by the line merely existing.
  //
  // The earlier version keyed off `carries`, which is only populated by the
  // player_rush_attempts market — and that market is not in the credit budget.
  // With it absent, `carries` was always zero, no player was ever identified as
  // a back, and every skill player on the board came out labelled WR.
  if (rushYards > 0 && rushYards >= recYards * 0.75) return 'RB';
  if (stats.has('receptions') || recYards > 0) return 'WR';
  return 'FLEX';
}

/**
 * Tight ends cannot be told from receivers by their prop lines — the two are
 * priced on exactly the same markets, and nothing in a receiving line says
 * which one a player is. The DraftKings export does say, so a slate with no
 * export has no tight ends in it.
 *
 * That is survivable on a showdown slate, where every roster spot takes any
 * position, and fatal on a classic one, which has a tight end slot that must be
 * filled. buildDfs refuses to build a classic slate without real positions
 * rather than quietly filling that slot with a receiver.
 */
export const POSITIONS_NEED_EXPORT = new Set(['TE']);

/**
 * Build one player's projection from every quote posted for them.
 *
 * `gameTouchdowns` is the number of touchdowns the game's total implies, used
 * to strip the margin out of the anytime-touchdown market — that market lists
 * a dozen players as "yes" with no "no" beside any of them, so it can only be
 * devigged against how many scorers there should actually be.
 */
export function projectPlayer(playerName, quotes, context = {}) {
  const { gameTouchdownScale = 1, declaredPosition = null, site = DEFAULT_SITE } = context;

  const means = new Map();
  const lines = [];

  for (const quote of quotes) {
    const spec = PLAYER_MARKETS[quote.marketKey];
    if (!spec) continue;

    const { probability, devigged } = fairProbability(quote);

    if (spec.kind === 'yes_no') {
      // Scaled against the game's touchdown supply rather than against a
      // missing other side. Anything but anytime TD is not used to project.
      if (spec.stat !== 'anytimeTd') continue;
      const scaled = Math.min(0.95, probability * gameTouchdownScale);
      means.set('anytimeTd', scaled);
      lines.push({ market: quote.marketKey, label: spec.label, line: null, probability: scaled, devigged: false, book: quote.book, americanOdds: quote.americanOdds });
      continue;
    }

    const mean = impliedMean(quote.line, probability, spec.stat);
    // A player can carry several lines for one stat (alternate lines). The one
    // closest to a coin flip is the best-conditioned: probabilities deep in a
    // tail invert into means that are very sensitive to small pricing errors.
    const existing = means.get(spec.stat);
    const balance = Math.abs(probability - 0.5);
    if (!existing || balance < existing.balance) {
      means.set(spec.stat, { mean, balance, line: quote.line, probability });
    }
    lines.push({ market: quote.marketKey, label: spec.label, line: quote.line, probability, devigged, book: quote.book, americanOdds: quote.americanOdds });
  }

  const statKeys = new Map(
    [...means.entries()]
      .filter(([key]) => key !== 'anytimeTd')
      .map(([key, v]) => [key, v.mean])
  );
  const position = declaredPosition ?? inferPosition(statKeys);

  const value = (stat) => statKeys.get(stat) ?? 0;

  const anytime = means.get('anytimeTd');
  const totalTds = anytime != null ? expectedTouchdowns(anytime) : 0;
  const split = TD_SPLIT[position] ?? TD_SPLIT.WR;

  const projection = {
    passYards: value('passYards'),
    passTds: value('passTds'),
    interceptions: value('interceptions'),
    passAttempts: value('passAttempts'),
    completions: value('completions'),
    rushYards: value('rushYards'),
    carries: value('carries'),
    receptions: value('receptions'),
    recYards: value('recYards'),
    kickingPoints: value('kickingPoints'),
    rushTds: totalTds * split.rush,
    recTds: totalTds * split.rec,
  };

  const bonuses = {
    pass300: projection.passYards > 0 ? probabilityOver(299.5, projection.passYards, 'passYards') : 0,
    rush100: projection.rushYards > 0 ? probabilityOver(99.5, projection.rushYards, 'rushYards') : 0,
    rec100: projection.recYards > 0 ? probabilityOver(99.5, projection.recYards, 'recYards') : 0,
  };

  const points = projectedPoints(projection, bonuses, site);

  return {
    playerName,
    playerId: normalizeName(playerName),
    position,
    projection,
    bonuses,
    anytimeTd: anytime ?? null,
    points,
    floor: pointsAtQuantile(projection, position, FLOOR_QUANTILE, site),
    ceiling: pointsAtQuantile(projection, position, CEILING_QUANTILE, site),
    lines,
  };
}

/**
 * Recompute everything a projection implies, after the stat line has changed.
 *
 * Reconciliation rewrites the stat line, and points, bonuses, floor and ceiling
 * are all derived from it. Leaving them as they were would put a player's
 * pre-reconciliation score next to their post-reconciliation stats — the DFS
 * pool would optimise against numbers that no longer match the projection shown
 * beside them.
 */
export function rescore(player, site = DEFAULT_SITE) {
  const { projection, position } = player;

  const bonuses = {
    pass300: projection.passYards > 0 ? probabilityOver(299.5, projection.passYards, 'passYards') : 0,
    rush100: projection.rushYards > 0 ? probabilityOver(99.5, projection.rushYards, 'rushYards') : 0,
    rec100: projection.recYards > 0 ? probabilityOver(99.5, projection.recYards, 'recYards') : 0,
  };

  return {
    ...player,
    bonuses,
    points: projectedPoints(projection, bonuses, site),
    floor: pointsAtQuantile(projection, position, FLOOR_QUANTILE, site),
    ceiling: pointsAtQuantile(projection, position, CEILING_QUANTILE, site),
  };
}

/**
 * Re-score a whole pool for a different site.
 *
 * The projections — yards, catches, touchdowns — are a forecast of the football
 * game and do not change between sites. What changes is what each site pays for
 * them, and that difference is large: a receiver catching ten passes is worth
 * eight fewer points on FanDuel than on DraftKings once half-PPR and the
 * missing hundred-yard bonus are applied. Optimising a FanDuel lineup against
 * DraftKings points would reliably prefer the wrong players, so the pool is
 * re-scored rather than reused.
 *
 * Defences are re-scored from their own projection, which both sites happen to
 * pay identically — the call is kept anyway so nothing depends on that staying
 * true.
 */
export function rescorePool(players, site = DEFAULT_SITE) {
  return players.map((player) =>
    player.position === 'DST' ? player : rescore(player, site)
  );
}

/**
 * Fantasy points when the player's whole stat line lands at one quantile.
 *
 * This assumes a player's own stats move together — that a big receiving game
 * means both the catches and the yards were up. They genuinely do: they share
 * the targets, the game script and the snap count that drive all of them. What
 * it deliberately does *not* assume is that different players move together,
 * which is handled separately where lineups are built.
 *
 * Touchdowns are shifted by a smaller amount than yardage. They are rare and
 * discrete, and pushing a 0.5-touchdown projection to its 85th percentile as if
 * it were continuous would invent a score that the underlying rate does not
 * support.
 */
export function pointsAtQuantile(projection, position, quantile, site = DEFAULT_SITE) {
  const z = normalQuantile(quantile);
  const shift = (stat, mean) => (mean > 0 ? Math.max(0, mean + impliedSd(mean, stat) * z) : 0);

  const shifted = {
    passYards: shift('passYards', projection.passYards),
    passTds: shift('passTds', projection.passTds),
    // Interceptions hurt, so a good game has fewer of them: invert the shift.
    interceptions: projection.interceptions > 0
      ? Math.max(0, projection.interceptions - impliedSd(projection.interceptions, 'interceptions') * z)
      : 0,
    rushYards: shift('rushYards', projection.rushYards),
    receptions: shift('receptions', projection.receptions),
    recYards: shift('recYards', projection.recYards),
    kickingPoints: shift('kickingPoints', projection.kickingPoints),
    rushTds: tdAtQuantile(projection.rushTds, quantile),
    recTds: tdAtQuantile(projection.recTds, quantile),
  };

  const bonuses = {
    pass300: shifted.passYards > 0 ? probabilityOver(299.5, shifted.passYards, 'passYards') : 0,
    rush100: shifted.rushYards > 0 ? probabilityOver(99.5, shifted.rushYards, 'rushYards') : 0,
    rec100: shifted.recYards > 0 ? probabilityOver(99.5, shifted.recYards, 'recYards') : 0,
  };

  return projectedPoints(shifted, bonuses, site);
}

/**
 * Touchdowns at a quantile, treated as the Poisson count they are.
 *
 * At the 85th percentile a player with a 0.6 expected touchdowns has scored
 * one, not 1.4 — the count is an integer and the upside is the whole
 * touchdown. Rounding the continuous shift would smear that into a number no
 * box score can produce.
 */
function tdAtQuantile(mean, quantile) {
  if (mean <= 0) return 0;
  let cumulative = 0;
  let term = Math.exp(-mean);
  for (let k = 0; k < 6; k++) {
    cumulative += term;
    if (cumulative >= quantile) return k;
    term *= mean / (k + 1);
  }
  return 6;
}

/**
 * Project a defence from the game lines alone.
 *
 * There is no prop market for a defence, but there does not need to be one: the
 * opponent's implied team total is the single best predictor of what a defence
 * scores, because it drives the points-allowed tier that dominates the scoring.
 * Sacks and takeaways are then scaled off the spread, since teams that fall
 * behind throw more and take more risks.
 */
export function projectDefense(team, opponentTotal, spread) {
  const pointsAllowed = Math.max(0, opponentTotal);

  // League-average sack and takeaway rates, nudged by how likely the opponent
  // is to be playing from behind. A team favoured by a touchdown generates
  // meaningfully more of both.
  const favouredBy = -spread;
  const pressure = 1 + Math.max(-0.4, Math.min(0.4, favouredBy / 20));
  const sacks = 2.3 * pressure;
  const takeaways = 1.4 * pressure;
  const defensiveTds = 0.12 * pressure;

  const tierPoints = expectedTierPoints(pointsAllowed);
  const points = round2(sacks * 1 + takeaways * 2 + defensiveTds * 6 + tierPoints);

  return {
    playerName: team,
    playerId: normalizeName(team),
    position: 'DST',
    projection: { pointsAllowed, sacks, takeaways, defensiveTds },
    points,
    // A defence's range is wide and lumpy — a return touchdown or a shutout is
    // most of its ceiling — so the band is set off the tier rather than fitted.
    floor: round2(points - 4.5),
    ceiling: round2(points + 9),
    lines: [],
  };
}

/**
 * Expected value of the points-allowed tier, not the tier of the expected
 * points.
 *
 * A defence projected to allow exactly 21 points sits on a tier boundary worth
 * 0, but half its outcomes land in the tier above worth 1 or more. Taking the
 * tier of the mean would throw that away and systematically underrate defences
 * against low-total offences, which is where the whole position's value is.
 */
export function expectedTierPoints(expectedAllowed) {
  const sd = Math.max(6, expectedAllowed * 0.45);
  const tiers = [
    { lo: -Infinity, hi: 0.5, points: 10 },
    { lo: 0.5, hi: 6.5, points: 7 },
    { lo: 6.5, hi: 13.5, points: 4 },
    { lo: 13.5, hi: 20.5, points: 1 },
    { lo: 20.5, hi: 27.5, points: 0 },
    { lo: 27.5, hi: 34.5, points: -1 },
    { lo: 34.5, hi: Infinity, points: -4 },
  ];

  let total = 0;
  for (const tier of tiers) {
    const probability = cdf(tier.hi, expectedAllowed, sd) - cdf(tier.lo, expectedAllowed, sd);
    total += probability * tier.points;
  }
  return total;
}

function cdf(x, mean, sd) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  // Reuse the shared normal CDF through a local import-free helper to keep this
  // module's dependency surface small.
  const z = (x - mean) / sd;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
