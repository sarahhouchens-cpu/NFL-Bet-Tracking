/**
 * Estimates how heavily each player will be rostered.
 *
 * Ownership is the whole reason tournament lineups and double-up lineups differ.
 * In a double-up you are trying to beat half the field, so being on the same
 * players as everyone else is safe — if the chalk hits, you advance with them.
 * In a tournament you are trying to beat all of it, and a lineup everyone else
 * also built cannot win one: when the chalk hits, so do the ten thousand tickets
 * identical to yours, and the prize splits ten thousand ways.
 *
 * Real ownership is only known after lock, and nothing here scrapes it. What it
 * does instead is model the thing that *drives* it: the field chases points per
 * dollar, so projected value predicts ownership well enough to tell chalk from
 * leverage. It is an estimate, and the site says so rather than dressing it up
 * as data.
 */

import { value as pointsPerDollar } from './scoring.js';

/**
 * How sharply the field concentrates on the best values.
 *
 * Higher makes ownership top-heavy. This is tuned so the best value on a main
 * slate lands somewhere in the 30-40% range, which is what a genuine chalk play
 * actually draws.
 */
const CONCENTRATION = 1.5;

/**
 * Roster spots available at each position across a nine-man classic lineup,
 * counting the share of the flex each position typically takes.
 *
 * Ownership across one position has to add up to the number of seats it fills:
 * if two and a half of the nine spots go to running backs, then all running
 * backs' ownership sums to about 250%. Without that anchor the numbers are
 * arbitrary and leverage means nothing.
 */
export const CLASSIC_SEATS = { QB: 1, RB: 2.6, WR: 3.5, TE: 1.2, DST: 1, K: 0 };

/** Showdown fills six seats from one game, with no position requirements. */
export const SHOWDOWN_SEATS = 6;

/**
 * Attach a projected ownership share to every player in a pool.
 *
 * Returns a new array; the input is not mutated, because the same pool is
 * scored for both lineup styles and one must not inherit the other's numbers.
 */
export function projectOwnership(pool, options = {}) {
  const { seats = CLASSIC_SEATS, concentration = CONCENTRATION } = options;

  const byPosition = new Map();
  for (const player of pool) {
    const key = player.position ?? 'FLEX';
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(player);
  }

  const out = [];
  for (const [position, players] of byPosition) {
    const values = players.map((p) => pointsPerDollar(p.points, p.salary));
    const mean = average(values);
    const sd = Math.max(standardDeviation(values, mean), 0.2);

    // Softmax over value. The exponential is what produces the real shape of an
    // ownership distribution — a couple of heavily-played names and a long tail
    // of players nobody touches — where a linear scaling would flatten it.
    const weights = values.map((v) => Math.exp(concentration * ((v - mean) / sd)));
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const totalShare = (seats[position] ?? 1) * 100;

    players.forEach((player, i) => {
      const raw = (weights[i] / totalWeight) * totalShare;
      out.push({
        ...player,
        value: values[i],
        // Nobody is on more than ~65% of lineups, and every playable body draws
        // at least a sliver. Clamping keeps leverage arithmetic well-behaved.
        ownership: Math.min(65, Math.max(0.3, round1(raw))),
      });
    });
  }

  return out;
}

/**
 * Leverage: how much ceiling a player offers relative to how popular they are.
 *
 * The square root is deliberate. Dividing straight by ownership makes every
 * 0.5%-owned fourth-string receiver look like the best play on the board, and a
 * lineup built from those has a ceiling it will never reach. Softening the
 * denominator rewards being contrarian without letting it override being good.
 */
export function leverage(player) {
  const owned = Math.max(0.5, player.ownership ?? 10);
  return (player.ceiling ?? player.points ?? 0) / Math.sqrt(owned);
}

function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
