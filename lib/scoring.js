/**
 * DraftKings NFL scoring, and the roster rules that go with it.
 *
 * These numbers are not approximate — they are the contest rules, and a lineup
 * optimised against slightly wrong scoring is optimised for a game nobody is
 * playing. The three-point bonuses in particular change roster construction:
 * they are why a 100-yard rusher is worth meaningfully more than the 10 points
 * their yardage alone suggests, and why high-total games are worth attacking.
 */

export const SALARY_CAP = 50000;

/** Classic roster: 9 players, one FLEX that takes a back, receiver or tight end. */
export const CLASSIC_ROSTER = [
  { slot: 'QB', eligible: ['QB'] },
  { slot: 'RB1', eligible: ['RB'] },
  { slot: 'RB2', eligible: ['RB'] },
  { slot: 'WR1', eligible: ['WR'] },
  { slot: 'WR2', eligible: ['WR'] },
  { slot: 'WR3', eligible: ['WR'] },
  { slot: 'TE', eligible: ['TE'] },
  { slot: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  { slot: 'DST', eligible: ['DST'] },
];

/** Showdown: a captain at 1.5x points and 1.5x salary, plus five flex spots. */
export const SHOWDOWN_ROSTER = [
  { slot: 'CPT', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], multiplier: 1.5 },
  { slot: 'FLEX1', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
  { slot: 'FLEX2', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
  { slot: 'FLEX3', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
  { slot: 'FLEX4', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
  { slot: 'FLEX5', eligible: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] },
];

export const POINTS = {
  passYard: 0.04,
  passTd: 4,
  interception: -1,
  pass300Bonus: 3,
  rushYard: 0.1,
  rushTd: 6,
  rush100Bonus: 3,
  reception: 1,
  recYard: 0.1,
  recTd: 6,
  rec100Bonus: 3,
  fumbleLost: -1,
  twoPointConversion: 2,
  returnTd: 6,
};

/**
 * Defence and special teams points allowed, scored in tiers.
 * Ordered high-to-low so the first matching bound wins.
 */
export const DST_POINTS_ALLOWED = [
  { max: 0, points: 10 },
  { max: 6, points: 7 },
  { max: 13, points: 4 },
  { max: 20, points: 1 },
  { max: 27, points: 0 },
  { max: 34, points: -1 },
  { max: Infinity, points: -4 },
];

export const DST_POINTS = {
  sack: 1,
  interception: 2,
  fumbleRecovery: 2,
  safety: 2,
  blockedKick: 2,
  touchdown: 6,
};

const num = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Score a skill-position stat line the way DraftKings does.
 *
 * Bonuses apply per category and stack: a back with 100 rushing yards and 100
 * receiving yards collects both. That is rare but it is the ceiling outcome a
 * tournament lineup is built to catch, so it must be scored, not rounded away.
 */
export function scorePlayer(stats = {}) {
  const passYards = num(stats.passYards);
  const rushYards = num(stats.rushYards);
  const recYards = num(stats.recYards);

  let points = 0;
  points += passYards * POINTS.passYard;
  points += num(stats.passTds) * POINTS.passTd;
  points += num(stats.interceptions) * POINTS.interception;
  points += rushYards * POINTS.rushYard;
  points += num(stats.rushTds) * POINTS.rushTd;
  points += num(stats.receptions) * POINTS.reception;
  points += recYards * POINTS.recYard;
  points += num(stats.recTds) * POINTS.recTd;
  points += num(stats.fumblesLost) * POINTS.fumbleLost;
  points += num(stats.twoPointConversions) * POINTS.twoPointConversion;
  points += num(stats.returnTds) * POINTS.returnTd;
  points += num(stats.kickingPoints);

  if (passYards >= 300) points += POINTS.pass300Bonus;
  if (rushYards >= 100) points += POINTS.rush100Bonus;
  if (recYards >= 100) points += POINTS.rec100Bonus;

  return round2(points);
}

/** Score a defence, including the points-allowed tier. */
export function scoreDst(stats = {}) {
  let points = 0;
  points += num(stats.sacks) * DST_POINTS.sack;
  points += num(stats.interceptions) * DST_POINTS.interception;
  points += num(stats.fumbleRecoveries) * DST_POINTS.fumbleRecovery;
  points += num(stats.safeties) * DST_POINTS.safety;
  points += num(stats.blockedKicks) * DST_POINTS.blockedKick;
  points += num(stats.touchdowns) * DST_POINTS.touchdown;
  points += DST_POINTS_ALLOWED.find((tier) => num(stats.pointsAllowed) <= tier.max).points;
  return round2(points);
}

/**
 * Expected fantasy points from a *projection* rather than a box score.
 *
 * This is deliberately not scorePlayer() on mean inputs. Bonuses are
 * threshold events, and the expected value of a threshold is its probability
 * times its size, not the bonus applied to the average. A receiver projected
 * for exactly 100 yards does not collect three points — they collect three
 * points about half the time. Feeding means into scorePlayer() would overpay
 * every player sitting near a bonus line and underpay the boom threats whose
 * distributions reach past it.
 *
 * `bonusProbabilities` carries those chances, computed from the fitted
 * distributions in distribution.js.
 */
export function projectedPoints(projection = {}, bonusProbabilities = {}) {
  const base =
    num(projection.passYards) * POINTS.passYard +
    num(projection.passTds) * POINTS.passTd +
    num(projection.interceptions) * POINTS.interception +
    num(projection.rushYards) * POINTS.rushYard +
    num(projection.rushTds) * POINTS.rushTd +
    num(projection.receptions) * POINTS.reception +
    num(projection.recYards) * POINTS.recYard +
    num(projection.recTds) * POINTS.recTd +
    num(projection.fumblesLost) * POINTS.fumbleLost +
    num(projection.kickingPoints);

  const bonuses =
    num(bonusProbabilities.pass300) * POINTS.pass300Bonus +
    num(bonusProbabilities.rush100) * POINTS.rush100Bonus +
    num(bonusProbabilities.rec100) * POINTS.rec100Bonus;

  return round2(base + bonuses);
}

/** Points per $1,000 of salary — the currency of roster construction. */
export function value(points, salary) {
  const s = num(salary);
  return s > 0 ? round2((num(points) / s) * 1000) : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
