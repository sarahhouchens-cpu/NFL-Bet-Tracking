/**
 * How two legs in the same game move together.
 *
 * This exists because the usual parlay arithmetic is wrong for football in a
 * specific and expensive way. Multiplying leg probabilities assumes
 * independence, and a flat "same game" penalty assumes every shared game makes
 * a ticket worse. Neither is true. A quarterback's passing yards and his own
 * receiver's yards are the *same event seen twice* — when one hits the other
 * usually has too, so that pair is far more likely than the multiplication
 * suggests. A running back's yards and his own quarterback's yards compete for
 * the same drives, so that pair is less likely.
 *
 * Getting the sign right matters more than getting the magnitude exact, because
 * the sign decides whether a ticket is attractive or a trap.
 */

/** Stats that represent a team throwing the ball. */
const PASSING = new Set(['passYards', 'passTds', 'passAttempts', 'completions']);
/** Stats that represent a player catching it. */
const RECEIVING = new Set(['recYards', 'receptions']);
/** Stats that represent a team running it. */
const RUSHING = new Set(['rushYards', 'carries']);

/**
 * Correlation between two legs, from -1 to 1. Zero means unrelated.
 *
 * Legs from different games are genuinely independent — different stadiums,
 * different weather, different fifty-three men — so they return 0 and the
 * plain multiplication is correct for them.
 */
export function legCorrelation(a, b) {
  if (!a.gameId || !b.gameId || a.gameId !== b.gameId) return 0;
  if (a.playerId === b.playerId) return 0.6; // same player, same afternoon

  const sameTeam = a.team && b.team && a.team === b.team;
  const aStat = a.stat;
  const bStat = b.stat;

  const isPass = (s) => PASSING.has(s);
  const isRec = (s) => RECEIVING.has(s);
  const isRush = (s) => RUSHING.has(s);
  const isTd = (s) => s === 'anytimeTd';

  if (sameTeam) {
    // The stack: a quarterback and his own receiver share every completion.
    if ((isPass(aStat) && isRec(bStat)) || (isRec(aStat) && isPass(bStat))) return 0.55;
    if ((isPass(aStat) && isTd(bStat)) || (isTd(aStat) && isPass(bStat))) return 0.35;

    // Two receivers on one team split a finite number of targets, but a big
    // team passing day lifts both. The competition slightly outweighs the lift.
    if (isRec(aStat) && isRec(bStat)) return -0.15;

    // Running and passing compete for drives on the same offence.
    if ((isPass(aStat) && isRush(bStat)) || (isRush(aStat) && isPass(bStat))) return -0.25;
    if ((isRec(aStat) && isRush(bStat)) || (isRush(aStat) && isRec(bStat))) return -0.2;

    // Two players scoring for one team needs that team to score twice, which a
    // good offensive day delivers.
    if (isTd(aStat) && isTd(bStat)) return 0.2;
    return 0.1;
  }

  // Opposite sides of the same game. A shootout lifts both passing games at
  // once, which is the classic bring-back.
  if ((isPass(aStat) || isRec(aStat)) && (isPass(bStat) || isRec(bStat))) return 0.3;
  if (isTd(aStat) && isTd(bStat)) return 0.15;

  // One team running the ball well usually means the other is behind and
  // throwing, and a team that runs out the clock takes plays off the board.
  if (isRush(aStat) && isRush(bStat)) return -0.3;
  if ((isRush(aStat) && (isPass(bStat) || isRec(bStat))) || (isRush(bStat) && (isPass(aStat) || isRec(aStat)))) return -0.15;

  return 0;
}

/**
 * Adjust a ticket's independent probability for the correlations inside it.
 *
 * The adjustment is applied pairwise and multiplicatively. For a positively
 * correlated pair the joint probability rises toward the weaker leg alone;
 * for a negative one it falls. The `strength` term keeps the whole thing
 * conservative: these correlations are estimates, and an estimate that
 * overstates a stack's chances turns a modelling error directly into a losing
 * bet.
 *
 * Note the asymmetry — positive correlation is credited at half the weight of
 * negative correlation. A ticket that is wrong about a negative correlation
 * merely misses; one that is wrong about a positive correlation has
 * systematically overpriced itself, so the cautious side is the cheap one.
 */
export function correlationAdjustment(legs, strength = 0.5) {
  let adjustment = 1;

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const rho = legCorrelation(legs[i], legs[j]);
      if (rho === 0) continue;

      const weight = rho > 0 ? strength * 0.5 : strength;
      const pi = legs[i].modelProbability;
      const pj = legs[j].modelProbability;

      // Bound the joint probability by the Fréchet limits: it can never exceed
      // the smaller leg, nor fall below the two overlapping as little as
      // possible. Interpolating between the independent product and the
      // relevant bound keeps every result a real probability.
      const independent = pi * pj;
      const target = rho > 0 ? Math.min(pi, pj) : Math.max(0, pi + pj - 1);
      const joint = independent + weight * Math.abs(rho) * (target - independent);

      if (independent > 0) adjustment *= joint / independent;
    }
  }

  return adjustment;
}

/** Plain-language label for a ticket's internal correlation. */
export function describeCorrelation(legs) {
  const games = new Set(legs.map((l) => l.gameId));
  if (games.size === legs.length) return 'Independent legs across different games.';

  const adjustment = correlationAdjustment(legs);
  if (adjustment > 1.05) return 'Correlated stack — these legs tend to hit together.';
  if (adjustment < 0.95) return 'Competing legs — these pull against each other.';
  return 'Same game, but the legs are largely unrelated.';
}
