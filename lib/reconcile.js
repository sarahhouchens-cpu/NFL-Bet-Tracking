/**
 * Makes a game's projections agree with each other.
 *
 * This is where the model earns its keep. Reading one line and inverting it
 * gives back exactly what the book already said, so a "model" built that way
 * can never disagree with a price and every edge it reports is zero by
 * construction. The signal has to come from somewhere else, and in a prop
 * market it comes from the fact that the lines are not independent of one
 * another:
 *
 *   - A receiver's yardage and his catches are linked by yards per reception.
 *   - A quarterback's passing yards are, to within a rounding error, the sum of
 *     his own receivers' receiving yards.
 *   - A back's rushing yards are his carries times his yards per carry.
 *
 * Books price each of those markets separately, and they do not always land in
 * the same place. When a receiver's catch line implies more volume than his
 * yardage line does, one of the two is wrong — and that disagreement, not any
 * private information, is the edge this repo bets on.
 *
 * Everything here shades toward consistency rather than snapping to it. The
 * posted line is still the best single estimate; the cross-check is a second
 * opinion, weighted as one.
 */

/** How much of the final projection comes from the market's own line. */
export const DIRECT_WEIGHT = 0.75;

/**
 * The furthest reconciliation may move a projection from its posted line.
 *
 * This is the most important guardrail in the module. The line is still the
 * best single estimate of a player's week, and a cross-check is a second
 * opinion, not a veto. Without a cap the arithmetic will happily conclude that
 * a receiver priced at 8.5 yards should be projected for 16 — and since that
 * conclusion is drawn from a ratio, it lands hardest on exactly the
 * low-volume players whose ratios are noisiest, filling the board with
 * confident nonsense about fourth receivers.
 *
 * Capping the move also caps the edge, which keeps the sanity limit in
 * parlay.js from being the only thing standing between the board and a bad bet.
 */
export const MAX_ADJUSTMENT = 0.15;

/**
 * How strongly a player's own implied rate is trusted over his position's.
 *
 * A receiver with 60 yards on 4 catches is telling you he runs deeper routes
 * than a receiver with 30 on 4, and that is real and persistent information —
 * not an error to be corrected away. So the rate is shrunk toward the
 * positional average rather than replaced by it, and only modestly.
 */
export const RATE_SHRINKAGE = 0.7;

/**
 * Yards per reception by position.
 *
 * These are stable league-wide: backs catch checkdowns, tight ends work the
 * middle, receivers run further downfield. They are the anchor a player's own
 * rate is shrunk toward, never a value imposed on him.
 */
export const YARDS_PER_RECEPTION = { WR: 12.5, TE: 10.5, RB: 7.5, QB: 9, FLEX: 11 };

/** Yards per carry, which varies far less between backs than volume does. */
export const YARDS_PER_CARRY = { RB: 4.4, QB: 5.2, WR: 7.0, FLEX: 4.4 };

/** Hold a reconciled value within the permitted distance of its posted line. */
export function capAdjustment(direct, adjusted, limit = MAX_ADJUSTMENT) {
  if (!(direct > 0)) return adjusted;
  return Math.min(direct * (1 + limit), Math.max(direct * (1 - limit), adjusted));
}

/**
 * Shrink a player's own implied rate toward his position's average.
 *
 * The two lines together imply a rate — yards per catch, yards per carry — and
 * when that rate is extreme it is usually the lines disagreeing rather than the
 * player being extraordinary. Shrinking expresses exactly that, and it is
 * symmetric: the same adjusted rate is used to move both lines, so the model
 * cannot claim the over on one and the over on the other.
 */
export function shrinkRate(direct, volume, positionalRate, shrinkage = RATE_SHRINKAGE) {
  if (!(direct > 0) || !(volume > 0)) return positionalRate;
  const implied = direct / volume;
  return implied * shrinkage + positionalRate * (1 - shrinkage);
}

/**
 * Reconcile one player's own stat lines against each other.
 *
 * Only applied where both sides of a relationship were actually posted — a
 * receiver with a yardage line and no catch line has nothing to be checked
 * against, and inventing the missing one would manufacture an edge out of
 * nothing.
 */
export function reconcilePlayer(player) {
  const projection = { ...player.projection };
  const ypr = YARDS_PER_RECEPTION[player.position] ?? YARDS_PER_RECEPTION.FLEX;
  const ypc = YARDS_PER_CARRY[player.position] ?? YARDS_PER_CARRY.FLEX;

  if (projection.receptions > 0 && projection.recYards > 0) {
    const rate = shrinkRate(projection.recYards, projection.receptions, ypr);
    projection.recYards = capAdjustment(projection.recYards, projection.receptions * rate);
    projection.receptions = capAdjustment(projection.receptions, projection.recYards / rate);
  }

  if (projection.carries > 0 && projection.rushYards > 0) {
    const rate = shrinkRate(projection.rushYards, projection.carries, ypc);
    projection.rushYards = capAdjustment(projection.rushYards, projection.carries * rate);
    projection.carries = capAdjustment(projection.carries, projection.rushYards / rate);
  }

  return { ...player, projection };
}

/**
 * Reconcile a team's passing game: the quarterback against his receivers.
 *
 * Every passing yard is also a receiving yard — the two are the same yards
 * counted at each end of the throw — so a team's receiving yards sum to its
 * passing yards exactly. The only slack is that a book does not post a line for
 * every body who might catch a pass, so the charted receivers account for
 * almost all of the total rather than all of it.
 *
 * This number does real work and the wrong value does real damage: setting it
 * meaningfully below 1 tells the model that every quarterback is underpriced,
 * and the board fills up with passing-yard overs that are an artefact of the
 * constant rather than anything a book got wrong.
 */
export const CHARTED_SHARE = 0.95;

const blend = (direct, implied, weight = DIRECT_WEIGHT) =>
  direct > 0 && implied > 0 ? direct * weight + implied * (1 - weight) : direct || implied || 0;

export function reconcileTeam(players) {
  const quarterback = players.find((p) => p.position === 'QB' && p.projection.passYards > 0);
  if (!quarterback) return players;

  const receivers = players.filter(
    (p) => p.playerId !== quarterback.playerId && p.projection.recYards > 0
  );
  if (receivers.length < 2) return players;

  const charted = receivers.reduce((sum, p) => sum + p.projection.recYards, 0);
  if (charted <= 0) return players;

  const impliedPassYards = charted / CHARTED_SHARE;
  const reconciled = capAdjustment(
    quarterback.projection.passYards,
    blend(quarterback.projection.passYards, impliedPassYards)
  );

  // Whatever the quarterback's line moved by, his receivers move the other way
  // by the same proportion — the two sides of the disagreement are split, not
  // resolved in the quarterback's favour.
  const receiverScale = (reconciled * CHARTED_SHARE) / charted;

  return players.map((player) => {
    if (player.playerId === quarterback.playerId) {
      return { ...player, projection: { ...player.projection, passYards: reconciled } };
    }
    if (player.projection.recYards > 0) {
      return {
        ...player,
        projection: {
          ...player.projection,
          recYards: player.projection.recYards * receiverScale,
        },
      };
    }
    return player;
  });
}

/**
 * Run every reconciliation over one game's players.
 *
 * Player-level first, then team-level: the team check compares a quarterback
 * against receiver yardage that has already been squared with its own catch
 * lines, so it is testing the projections rather than the raw posted numbers.
 */
export function reconcileGame(players) {
  const individual = players.map((player) =>
    player.position === 'DST' ? player : reconcilePlayer(player)
  );

  const byTeam = new Map();
  const unassigned = [];
  for (const player of individual) {
    if (!player.team) {
      unassigned.push(player);
      continue;
    }
    if (!byTeam.has(player.team)) byTeam.set(player.team, []);
    byTeam.get(player.team).push(player);
  }

  const out = [...unassigned];
  for (const teamPlayers of byTeam.values()) out.push(...reconcileTeam(teamPlayers));
  return out;
}
