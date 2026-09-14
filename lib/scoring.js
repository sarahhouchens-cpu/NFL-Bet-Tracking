/**
 * Fantasy scoring, parameterised by site.
 *
 * These numbers are not approximate — they are the contest rules, and a lineup
 * optimised against slightly wrong scoring is optimised for a game nobody is
 * playing. The tables themselves live in sites.js; this module is the
 * arithmetic that reads them.
 *
 * The default is DraftKings throughout, so every caller that predates FanDuel
 * support keeps its old behaviour untouched.
 */

import { DRAFTKINGS, DEFAULT_SITE, rosterFor, slotSalary } from './sites.js';

export { slotSalary };

/**
 * DraftKings' cap and rosters, re-exported so callers that only ever deal with
 * one site do not have to reach for a site object.
 */
export const SALARY_CAP = DRAFTKINGS.salaryCap;
export const CLASSIC_ROSTER = rosterFor(DRAFTKINGS, 'classic');
export const SHOWDOWN_ROSTER = rosterFor(DRAFTKINGS, 'showdown');

/** The DraftKings point table, kept exported for callers that assume it. */
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
 * Score a skill-position stat line the way the site scores it.
 *
 * Bonuses apply per category and stack: on DraftKings a back with 100 rushing
 * yards and 100 receiving yards collects both. That is rare, but it is the
 * ceiling outcome a tournament lineup is built to catch, so it is scored rather
 * than rounded away. FanDuel has no bonuses, and its table simply carries none.
 */
export function scorePlayer(stats = {}, site = DEFAULT_SITE) {
  const table = site.scoring;
  const passYards = num(stats.passYards);
  const rushYards = num(stats.rushYards);
  const recYards = num(stats.recYards);

  let points = 0;
  points += passYards * table.passYard;
  points += num(stats.passTds) * table.passTd;
  points += num(stats.interceptions) * table.interception;
  points += rushYards * table.rushYard;
  points += num(stats.rushTds) * table.rushTd;
  points += num(stats.receptions) * table.reception;
  points += recYards * table.recYard;
  points += num(stats.recTds) * table.recTd;
  points += num(stats.fumblesLost) * table.fumbleLost;
  points += num(stats.twoPointConversions) * table.twoPointConversion;
  points += num(stats.returnTds) * table.returnTd;
  points += num(stats.kickingPoints);

  const actual = { passYards, rushYards, recYards };
  for (const bonus of table.bonuses) {
    if (actual[bonus.stat] >= bonus.at) points += bonus.points;
  }

  return round2(points);
}

/** Score a defence, including the points-allowed tier. */
export function scoreDst(stats = {}, site = DEFAULT_SITE) {
  const table = site.dst;
  let points = 0;
  points += num(stats.sacks) * table.sack;
  points += num(stats.interceptions) * table.interception;
  points += num(stats.fumbleRecoveries) * table.fumbleRecovery;
  points += num(stats.safeties) * table.safety;
  points += num(stats.blockedKicks) * table.blockedKick;
  points += num(stats.touchdowns) * table.touchdown;
  points += DST_POINTS_ALLOWED.find((tier) => num(stats.pointsAllowed) <= tier.max).points;
  return round2(points);
}

/**
 * Expected fantasy points from a *projection* rather than a box score.
 *
 * This is deliberately not scorePlayer() on mean inputs. Bonuses are threshold
 * events, and the expected value of a threshold is its probability times its
 * size, not the bonus applied to the average. A receiver projected for exactly
 * 100 yards does not collect three points — they collect three points about
 * half the time. Feeding means into scorePlayer() would overpay every player
 * sitting near a bonus line and underpay the boom threats whose distributions
 * reach past it.
 *
 * `bonusProbabilities` carries those chances, keyed by the bonus keys in the
 * site's table, and is simply unused on a site with no bonuses.
 */
export function projectedPoints(projection = {}, bonusProbabilities = {}, site = DEFAULT_SITE) {
  const table = site.scoring;

  const base =
    num(projection.passYards) * table.passYard +
    num(projection.passTds) * table.passTd +
    num(projection.interceptions) * table.interception +
    num(projection.rushYards) * table.rushYard +
    num(projection.rushTds) * table.rushTd +
    num(projection.receptions) * table.reception +
    num(projection.recYards) * table.recYard +
    num(projection.recTds) * table.recTd +
    num(projection.fumblesLost) * table.fumbleLost +
    num(projection.kickingPoints);

  let bonuses = 0;
  for (const bonus of table.bonuses) {
    bonuses += num(bonusProbabilities[bonus.key]) * bonus.points;
  }

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
