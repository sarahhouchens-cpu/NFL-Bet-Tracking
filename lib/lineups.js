/**
 * Builds DraftKings lineups.
 *
 * Two contest types, two genuinely different problems — and conflating them is
 * the most common way to lose money in daily fantasy.
 *
 *   double-up — roughly the top half of the field doubles their money, and
 *               everyone above the line wins exactly the same amount. Finishing
 *               first pays no better than finishing at the cut, so upside past
 *               the cut is worthless. What matters is the chance of clearing it,
 *               which means a high floor: reliable volume, no coin flips, and
 *               no lineup-wide risk from stacking one game that might be a dud.
 *
 *   tournament — the prize pool is concentrated at the very top, so the goal is
 *               not a good score, it is a winning one. That demands a ceiling,
 *               which in football comes from correlation: a quarterback and his
 *               receivers all peak in the same game, so a stack turns one good
 *               afternoon into several scoring events at once. It also demands
 *               being different, because a lineup the field also built splits
 *               its prize with the field.
 *
 * So the double-up builder maximises floor and avoids correlation, and the
 * tournament builder maximises correlated ceiling and pays for being contrarian.
 * They are not the same optimiser with a different knob.
 */

import { SALARY_CAP, CLASSIC_ROSTER, SHOWDOWN_ROSTER, value as pointsPerDollar } from './scoring.js';
import { projectOwnership, leverage, CLASSIC_SEATS, SHOWDOWN_SEATS } from './ownership.js';

/** Pass catchers — the players a quarterback stack can be built from. */
const PASS_CATCHERS = new Set(['WR', 'TE']);

export const CONTEST_TYPES = {
  double_up: {
    id: 'double_up',
    name: 'Double Up',
    blurb: 'Cash game. Beat half the field; upside past the cut pays nothing.',
  },
  tournament: {
    id: 'tournament',
    name: 'Tournament',
    blurb: 'GPP. Top-heavy payouts; you need a ceiling and you need to be different.',
  },
};

/**
 * How a player is scored, by contest type.
 *
 * The double-up blend leans on the floor but does not ignore the projection —
 * a lineup of nothing but floors leaves too many points on the table to clear
 * the cut. The tournament blend leans on the ceiling and then adds leverage,
 * which is what makes it prefer the second-best play at a fifth of the
 * ownership.
 */
export function playerScore(player, contest) {
  const points = player.points ?? 0;
  const floor = player.floor ?? points * 0.6;
  const ceiling = player.ceiling ?? points * 1.6;

  if (contest === 'double_up') return 0.6 * points + 0.4 * floor;

  // Tournament: ceiling-weighted, with a leverage premium for being off the
  // field's board. The premium is additive and modest — it breaks ties between
  // comparable plays rather than dragging bad ones onto the roster.
  return 0.4 * points + 0.6 * ceiling + 0.6 * leverage(player);
}

/**
 * What a player adds to the lineup already assembled, beyond their own score.
 *
 * A per-player score cannot express the one thing that decides a tournament
 * lineup: two players are worth more together than apart when they peak in the
 * same game. Scoring each candidate against the roster so far lets the beam
 * build correlation deliberately rather than waiting for a locked stack to
 * impose it — and lets the double-up builder do the exact opposite, paying a
 * small premium for players whose outcomes are unrelated to the ones already in.
 *
 * The term is the covariance a player contributes to the lineup's variance,
 * scaled to sit alongside the point-based score rather than swamp it.
 */
export function fitBonus(player, chosen, contest) {
  if (!chosen.length) return 0;

  const sd = playerSd(player);
  let covariance = 0;
  for (const other of chosen) {
    const rho = playerCorrelation(player, other);
    if (rho !== 0) covariance += rho * sd * playerSd(other) * (other.multiplier ?? 1);
  }

  // A tournament wants variance and a double-up wants it gone, so the same
  // quantity is rewarded in one and charged for in the other.
  const weight = contest === 'tournament' ? 0.1 : -0.08;

  // Bounded, because this term is a tie-breaker between comparable players and
  // not a scoring objective of its own. Left uncapped it will trade away real
  // projected points to buy correlation — or, in a cash lineup, to buy the
  // absence of it — and the optimiser starts preferring players for how they
  // move rather than for how much they score.
  const bonus = weight * covariance;
  const ceiling = 0.35 * Math.abs(playerScore(player, contest));
  return Math.max(-ceiling, Math.min(ceiling, bonus));
}

/**
 * Roster rules that differ by contest type.
 *
 * `maxPerTeam` is the one doing the most work. Three players from one team is a
 * stack; in a double-up that is a single point of failure, because if that
 * offence is shut out a third of the lineup goes with it. In a tournament it is
 * the entire plan.
 */
export const CONTEST_RULES = {
  double_up: {
    maxPerTeam: 2,
    maxPerGame: 3,
    requireStack: false,
    minDifference: 2,
    maxExposure: 0.7,
    blockOpposingDst: true,
    allowQbStack: false,
  },
  tournament: {
    maxPerTeam: 4,
    maxPerGame: 5,
    requireStack: true,
    minDifference: 3,
    maxExposure: 0.67,
    blockOpposingDst: true,
    allowQbStack: true,
  },
};

/**
 * Showdown is one game, so the classic limits are not merely wrong, they are
 * unsatisfiable: every one of the six rostered players is in the same game, and
 * a defence there is always opposite somebody you own. Capping a game at five
 * would reject every legal lineup.
 */
export const SHOWDOWN_RULES = {
  double_up: {
    maxPerTeam: 4,
    maxPerGame: 6,
    requireStack: false,
    minDifference: 2,
    maxExposure: 0.7,
    blockOpposingDst: false,
  },
  tournament: {
    maxPerTeam: 5,
    maxPerGame: 6,
    requireStack: false,
    minDifference: 2,
    maxExposure: 0.67,
    blockOpposingDst: false,
  },
};

/**
 * Assign locked players to roster slots before the search starts.
 *
 * A forced stack has to actually occupy seats. Filtering finished lineups for
 * the ones that happen to contain the stack does not work — the beam optimises
 * freely, so the stack survives only where it was also the best value, which is
 * exactly the case where forcing it was unnecessary.
 *
 * Scarce slots are filled first: a tight end fits only the TE and FLEX seats,
 * while a receiver fits three, so assigning the receiver first can strand the
 * tight end with nowhere to go.
 */
export function assignLocked(roster, locked) {
  const taken = new Map();
  const remaining = roster.map((slot, index) => ({ slot, index }));

  const ordered = [...locked].sort(
    (a, b) =>
      remaining.filter((r) => r.slot.eligible.includes(a.position)).length -
      remaining.filter((r) => r.slot.eligible.includes(b.position)).length
  );

  for (const player of ordered) {
    // Prefer a dedicated slot over the FLEX, so the FLEX stays free for whoever
    // has no other home.
    const candidates = remaining
      .filter((r) => !taken.has(r.index) && r.slot.eligible.includes(player.position))
      .sort((a, b) => a.slot.eligible.length - b.slot.eligible.length);

    if (!candidates.length) return null;
    taken.set(candidates[0].index, player);
  }

  return taken;
}

/**
 * Fill a roster by beam search.
 *
 * Exhaustive enumeration is out — a main slate pool makes billions of legal
 * nine-man lineups — and pure greedy fills the expensive slots first and then
 * cannot afford a tight end. Beam search keeps the best few hundred partial
 * lineups at every step, which recovers almost all of the quality of a full
 * search at a tiny fraction of the work.
 *
 * The salary check is what makes it work rather than just making it fast: a
 * partial lineup is abandoned as soon as the cheapest possible completion would
 * still bust the cap, so the beam never fills with states that cannot finish.
 */
export function fillRoster(roster, pool, options = {}) {
  const {
    contest = 'double_up',
    salaryCap = SALARY_CAP,
    beamWidth = 300,
    locked = [],
    rules = CONTEST_RULES[contest] ?? CONTEST_RULES.double_up,
    collect = 200,
  } = options;

  const lockedSlots = assignLocked(roster, locked);
  if (!lockedSlots) return [];

  const lockedIds = new Set(locked.map((p) => p.playerId));
  const available = pool.filter((p) => !lockedIds.has(p.playerId));

  const eligibleFor = (slot) =>
    available
      .filter((p) => slot.eligible.includes(p.position))
      .sort((a, b) => playerScore(b, contest) - playerScore(a, contest));

  // Only the unlocked slots are searched; the rest are already spoken for.
  const openSlots = roster
    .map((slot, index) => ({ slot, index }))
    .filter((entry) => !lockedSlots.has(entry.index));

  const bySlot = openSlots.map((entry) => eligibleFor(entry.slot));

  // Cheapest player available to each remaining slot, so a partial lineup can
  // be tested for whether it can still be completed inside the cap.
  const minCostFrom = new Array(openSlots.length + 1).fill(0);
  for (let i = openSlots.length - 1; i >= 0; i--) {
    const cheapest = bySlot[i].length ? Math.min(...bySlot[i].map((p) => p.salary)) : Infinity;
    minCostFrom[i] = minCostFrom[i + 1] + cheapest;
  }

  const seedPlayers = [];
  let seedSalary = 0;
  let seedScore = 0;
  const seedUsed = new Set();
  for (const [index, player] of lockedSlots) {
    const slot = roster[index];
    seedPlayers.push({ ...player, slot: slot.slot, multiplier: slot.multiplier ?? 1 });
    seedSalary += player.salary;
    seedScore += playerScore(player, contest) * (slot.multiplier ?? 1);
    seedUsed.add(player.playerId);
  }

  if (seedSalary + (minCostFrom[0] ?? 0) > salaryCap) return [];

  let states = [
    { players: seedPlayers, salary: seedSalary, score: seedScore, used: seedUsed, slotIndex: {} },
  ];

  for (let position = 0; position < openSlots.length; position++) {
    const { slot } = openSlots[position];
    const candidates = bySlot[position];
    const next = [];

    for (const state of states) {
      // Slots with identical eligibility are interchangeable, so requiring each
      // pick to come later in the sorted list than the previous one from the
      // same group removes the permutations of a single lineup. Without this
      // the beam fills with the same nine players in a different order.
      const groupKey = slot.eligible.join('/');
      const startFrom = state.slotIndex[groupKey] ?? 0;

      for (let i = startFrom; i < candidates.length; i++) {
        const player = candidates[i];
        if (state.used.has(player.playerId)) continue;

        const salary = state.salary + player.salary;
        if (salary + (minCostFrom[position + 1] ?? 0) > salaryCap) continue;

        const players = [...state.players, { ...player, slot: slot.slot, multiplier: slot.multiplier ?? 1 }];
        if (!satisfiesRules(players, rules)) continue;

        const used = new Set(state.used);
        used.add(player.playerId);

        next.push({
          players,
          salary,
          score:
            state.score +
            (playerScore(player, contest) + fitBonus(player, state.players, contest)) *
              (slot.multiplier ?? 1),
          used,
          slotIndex: { ...state.slotIndex, [groupKey]: i + 1 },
        });
      }
    }

    if (!next.length) return [];
    next.sort((a, b) => b.score - a.score);
    states = next.slice(0, beamWidth);
  }

  return states.slice(0, collect).map((state) => summarize(state.players, contest));
}

/**
 * Constraints checked as a lineup is assembled rather than at the end.
 *
 * Checking partway is what keeps the beam useful — a state that already breaks
 * a team limit can never recover, and leaving it in crowds out states that can.
 */
function satisfiesRules(players, rules) {
  const perTeam = new Map();
  const perGame = new Map();

  for (const player of players) {
    if (player.team) perTeam.set(player.team, (perTeam.get(player.team) ?? 0) + 1);
    if (player.gameId) perGame.set(player.gameId, (perGame.get(player.gameId) ?? 0) + 1);
  }

  // A defence against an offence you are also rostering is a bet against
  // yourself: your receiver's touchdown is points off your defence's score.
  // Two defences from the same game cancel each other out by construction:
  // every point one allows is a point the other's offence scored. The pair has
  // almost no joint upside, and because the variance model correctly reports
  // them as strongly negatively correlated, a floor-maximising objective will
  // actively seek them out — it can drive a lineup's spread to nearly zero,
  // which reads as a wonderful floor and is really a lineup that cannot reach
  // any cut. Ruling the pair out is simpler and safer than trying to price it.
  const defences = players.filter((p) => p.position === 'DST');
  const defenceGames = new Set(defences.map((p) => p.gameId));
  if (defences.length > defenceGames.size) return false;

  const dst = defences[0];
  if (dst && rules.blockOpposingDst !== false) {
    const opposed = players.some(
      (p) => p.position !== 'DST' && p.gameId && p.gameId === dst.gameId && p.team !== dst.team
    );
    if (opposed) return false;
  }

  for (const [team, count] of perTeam) {
    if (count > rules.maxPerTeam) return false;
  }

  // A double-up lineup is built to clear a cut, and pairing a quarterback with
  // his own receiver ties two roster spots to one team having a good day. That
  // shared upside is worth paying for in a tournament and is a liability here,
  // where the extra ceiling pays nothing and the extra downside costs the
  // entry. Keeping the rule here rather than only in the objective means a cash
  // lineup cannot back into a stack just because the values lined up.
  if (rules.allowQbStack === false) {
    const qb = players.find((p) => p.position === 'QB');
    if (qb && players.some((p) => p.team === qb.team && PASS_CATCHERS.has(p.position))) return false;
  }
  for (const [, count] of perGame) {
    if (count > rules.maxPerGame) return false;
  }

  return true;
}

/**
 * How two rostered players' fantasy scores move together.
 *
 * These are the standard shapes of NFL correlation, and they are the reason
 * stacking exists. A quarterback and his receiver share the same completions —
 * one throw is points for both — so their scores rise and fall as one. A
 * defence and the offence it is facing are the mirror image: every touchdown
 * the offence scores is points off the defence's total.
 */
export function playerCorrelation(a, b) {
  if (!a.gameId || !b.gameId || a.gameId !== b.gameId) return 0;

  const sameTeam = a.team === b.team;
  const pair = (x, y) => (a.position === x && b.position === y) || (a.position === y && b.position === x);

  if (sameTeam) {
    if (pair('QB', 'WR')) return 0.6;
    if (pair('QB', 'TE')) return 0.5;
    if (pair('QB', 'RB')) return 0.1;
    if (pair('WR', 'WR')) return 0.05;
    if (pair('WR', 'TE')) return 0.05;
    if (pair('RB', 'WR') || pair('RB', 'TE')) return -0.05;
    if (pair('RB', 'RB')) return -0.3;
    if (a.position === 'DST' || b.position === 'DST') return 0.15;
    return 0;
  }

  // Opposite sides of the same game.
  if (a.position === 'DST' || b.position === 'DST') return -0.45;
  if (pair('QB', 'QB')) return 0.2;
  if (pair('QB', 'WR') || pair('QB', 'TE') || pair('WR', 'WR') || pair('WR', 'TE')) return 0.25;
  if (pair('RB', 'RB')) return -0.25;
  if (a.position === 'RB' || b.position === 'RB') return -0.1;
  return 0.05;
}

/**
 * Spread of one player's outcomes, backed out of the floor-to-ceiling band.
 *
 * The band is the 20th to 85th percentile of a fitted normal, which spans
 * 1.878 standard deviations, so dividing by that recovers the spread the
 * projection implied.
 */
const BAND_WIDTH_IN_SDS = 1.878;

function playerSd(player) {
  const ceiling = player.ceiling ?? 0;
  const floor = player.floor ?? 0;
  const band = Math.max(0, ceiling - floor);
  // A player with no band still has variance; fall back to a share of the mean.
  return band > 0 ? band / BAND_WIDTH_IN_SDS : Math.max(1, (player.points ?? 0) * 0.4);
}

/**
 * A lineup's own floor and ceiling, rather than the sum of its players'.
 *
 * Adding up nine individual ceilings describes an afternoon in which every one
 * of nine players independently has their best game — which essentially never
 * happens, and which would rank a lineup of nine unrelated boom plays above a
 * stack that can actually get there. The right question is the spread of the
 * lineup's *total*, and that depends on how the players move together:
 *
 *   Var(total) = sum of variances + twice the sum of covariances
 *
 * Uncorrelated players diversify each other away, pulling the total toward its
 * mean and producing a high floor and a modest ceiling — a double-up lineup.
 * Correlated players do not diversify, so the total keeps its spread and
 * reaches much further in both directions — a tournament lineup. This is the
 * arithmetic reason stacking wins tournaments, and computing it this way is
 * what lets the two builders be compared honestly on the same axis.
 */
export function lineupRange(players) {
  const mean = players.reduce((sum, p) => sum + (p.points ?? 0) * (p.multiplier ?? 1), 0);

  let variance = 0;
  for (let i = 0; i < players.length; i++) {
    const si = playerSd(players[i]) * (players[i].multiplier ?? 1);
    variance += si * si;
    for (let j = i + 1; j < players.length; j++) {
      const sj = playerSd(players[j]) * (players[j].multiplier ?? 1);
      variance += 2 * playerCorrelation(players[i], players[j]) * si * sj;
    }
  }

  // Negative correlations can in principle drive the sum below zero; a lineup
  // with no variance is not a real description of a football afternoon.
  const sd = Math.sqrt(Math.max(variance, 1));

  return {
    mean: round2(mean),
    sd: round2(sd),
    // The same 20th and 85th percentiles the player bands use, so a lineup's
    // range is quoted on the same scale as the players inside it.
    floor: round2(mean - 0.842 * sd),
    ceiling: round2(mean + 1.036 * sd),
  };
}

/** Collapse a chosen roster into the shape the site and the tests consume. */
function summarize(players, contest) {
  const salary = players.reduce((sum, p) => sum + p.salary, 0);
  const range = lineupRange(players);

  return {
    contest,
    players,
    salary,
    salaryRemaining: SALARY_CAP - salary,
    points: range.mean,
    floor: range.floor,
    ceiling: range.ceiling,
    sd: range.sd,
    ownership: round1(players.reduce((sum, p) => sum + (p.ownership ?? 0), 0)),
    value: pointsPerDollar(range.mean, salary),
    stack: describeStack(players),
  };
}

/**
 * Name the correlation structure in a lineup, so the recommendation can be
 * read rather than just trusted.
 */
export function describeStack(players) {
  const qb = players.find((p) => p.position === 'QB');
  if (!qb) return null;

  const withQb = players.filter(
    (p) => p.playerId !== qb.playerId && p.team === qb.team && PASS_CATCHERS.has(p.position)
  );
  const bringBack = players.filter(
    (p) => p.gameId && p.gameId === qb.gameId && p.team !== qb.team && p.position !== 'DST'
  );

  if (!withQb.length) return null;

  const parts = [`${qb.playerName} + ${withQb.map((p) => p.playerName).join(' + ')}`];
  if (bringBack.length) parts.push(`back with ${bringBack.map((p) => p.playerName).join(', ')}`);

  return {
    label: parts.join(', '),
    size: withQb.length + 1,
    bringBack: bringBack.length,
    team: qb.team,
  };
}

/**
 * Build tournament lineups around explicit stacks.
 *
 * Rather than hoping a general search stumbles onto correlation, this enumerates
 * the stacks worth having — each quarterback with one or two of his own pass
 * catchers, plus an opponent to bring the game back — and optimises the rest of
 * the roster around each one. That is how the structure ends up in every lineup
 * instead of only the ones where the stack happened to also be the best value.
 */
export function buildTournamentLineups(pool, options = {}) {
  const { count = 3, roster = CLASSIC_ROSTER, maxStacks = 14, rules = CONTEST_RULES.tournament } = options;

  const quarterbacks = pool
    .filter((p) => p.position === 'QB')
    .sort((a, b) => playerScore(b, 'tournament') - playerScore(a, 'tournament'))
    .slice(0, 8);

  const lineups = [];

  let stacksTried = 0;
  for (const qb of quarterbacks) {
    if (stacksTried >= maxStacks) break;

    const mates = pool
      .filter((p) => p.team === qb.team && PASS_CATCHERS.has(p.position))
      .sort((a, b) => (b.ceiling ?? 0) - (a.ceiling ?? 0))
      .slice(0, 3);

    const opponents = pool
      .filter((p) => p.gameId === qb.gameId && p.team !== qb.team && PASS_CATCHERS.has(p.position))
      .sort((a, b) => leverage(b) - leverage(a))
      .slice(0, 2);

    if (!mates.length) continue;

    for (const mate of mates) {
      for (const bringBack of [...opponents, null]) {
        if (stacksTried >= maxStacks) break;
        stacksTried++;

        const locked = bringBack ? [qb, mate, bringBack] : [qb, mate];
        const built = fillRoster(roster, pool, {
          contest: 'tournament',
          locked,
          rules,
          collect: 40,
        });
        lineups.push(...built.filter((l) => locked.every((p) => l.players.some((x) => x.playerId === p.playerId))));
      }
    }
  }

  return selectDiverse(lineups, { count, rules, sortKey: 'ceiling' });
}

/** Build double-up lineups: floor first, correlation avoided. */
export function buildDoubleUpLineups(pool, options = {}) {
  const { count = 3, roster = CLASSIC_ROSTER, rules = CONTEST_RULES.double_up } = options;

  const built = fillRoster(roster, pool, {
    contest: 'double_up',
    rules,
    collect: 300,
    beamWidth: 400,
  });

  return selectDiverse(built, { count, rules, sortKey: 'floor' });
}

/**
 * Pick a spread of lineups rather than the same one N times.
 *
 * The top of any optimiser's output is a run of near-identical lineups that
 * differ by one cheap player, and entering those is the same bet several times
 * over at several times the cost. Requiring a minimum number of different
 * players, and capping how often any one player may appear, turns the list into
 * genuinely separate entries.
 */
export function selectDiverse(lineups, options = {}) {
  const { count = 3, rules = CONTEST_RULES.tournament, sortKey = 'points' } = options;

  const ranked = [...lineups].sort((a, b) => {
    const primary = (b[sortKey] ?? 0) - (a[sortKey] ?? 0);
    return primary !== 0 ? primary : (b.points ?? 0) - (a.points ?? 0);
  });

  const chosen = [];
  const exposure = new Map();
  const seen = new Set();

  for (const lineup of ranked) {
    if (chosen.length >= count) break;

    const ids = lineup.players.map((p) => p.playerId).sort();
    const signature = ids.join('|');
    if (seen.has(signature)) continue;

    const tooSimilar = chosen.some((existing) => {
      const other = new Set(existing.players.map((p) => p.playerId));
      const shared = ids.filter((id) => other.has(id)).length;
      return ids.length - shared < rules.minDifference;
    });
    if (tooSimilar) continue;

    const overExposed = ids.some(
      (id) => (exposure.get(id) ?? 0) + 1 > Math.max(1, Math.ceil(count * rules.maxExposure))
    );
    if (overExposed) continue;

    seen.add(signature);
    for (const id of ids) exposure.set(id, (exposure.get(id) ?? 0) + 1);
    chosen.push(lineup);
  }

  return chosen;
}

/**
 * Relax the team limit until the roster is actually fillable.
 *
 * A small slate can make a limit unsatisfiable rather than merely strict: two
 * games is four teams, and a nine-man roster capped at two players per team can
 * only ever reach eight. The optimiser would return nothing, and "no lineups"
 * is a far worse answer than "a slightly more concentrated lineup than usual".
 *
 * The cap is raised only as far as feasibility requires, so a full main slate
 * keeps the strict limit it was given.
 */
export function feasibleRules(rules, roster, pool) {
  const teams = new Set(pool.map((p) => p.team).filter(Boolean));
  const games = new Set(pool.map((p) => p.gameId).filter(Boolean));
  if (!teams.size) return rules;

  const needPerTeam = Math.ceil(roster.length / teams.size);
  const needPerGame = Math.ceil(roster.length / Math.max(1, games.size));

  const maxPerTeam = Math.max(rules.maxPerTeam, needPerTeam);
  const maxPerGame = Math.max(rules.maxPerGame, needPerGame);

  // The defence rule interacts with the game limit, and the two together can be
  // unsatisfiable even when neither is alone. Barring opposing players means the
  // defence's game can only supply that defence's own team, so the slate's real
  // capacity is every other game at its limit, plus one team from the
  // defence's. On a three-game slate capped at three per game and two per team
  // that comes to eight seats for a nine-man roster, and the optimiser returns
  // nothing with no indication why.
  const capacity = (games.size - 1) * maxPerGame + Math.min(maxPerGame, maxPerTeam);

  return {
    ...rules,
    maxPerTeam,
    maxPerGame,
    // Rostering a defence against a player you own is a bet against yourself,
    // but on a slate this small there are not enough bodies to avoid it and
    // fielding no lineup at all is the worse trade.
    blockOpposingDst: rules.blockOpposingDst && capacity >= roster.length,
  };
}

/**
 * Both lineup styles for one slate.
 *
 * Ownership is projected once per slate and shared, because it is a property of
 * the slate's player pool rather than of the contest you enter.
 */
export function recommendForSlate(players, slate, options = {}) {
  const { count = 3 } = options;
  const showdown = slate?.format === 'showdown';

  const pool = projectOwnership(players, {
    seats: showdown ? { QB: 1, RB: 1.4, WR: 2, TE: 0.8, DST: 0.4, K: 0.4 } : CLASSIC_SEATS,
  }).filter((p) => Number.isFinite(p.salary) && p.salary > 0 && (p.points ?? 0) > 0);

  const roster = showdown ? SHOWDOWN_ROSTER : CLASSIC_ROSTER;
  const base = showdown ? SHOWDOWN_RULES : CONTEST_RULES;
  const rules = {
    tournament: feasibleRules(base.tournament, roster, pool),
    double_up: feasibleRules(base.double_up, roster, pool),
  };

  // On a showdown slate there is no quarterback stack to enumerate — every
  // player is already in the one game — so the tournament build is the same
  // beam search run against the ceiling-and-leverage objective.
  const tournament = showdown
    ? selectDiverse(
        fillRoster(roster, pool, { contest: 'tournament', rules: rules.tournament, collect: 300, beamWidth: 400 }),
        { count, rules: rules.tournament, sortKey: 'ceiling' }
      )
    : buildTournamentLineups(pool, { count, roster, rules: rules.tournament });

  return {
    slate: { id: slate.id, name: slate.name, format: slate.format, startsAt: slate.startsAt },
    poolSize: pool.length,
    tournament,
    doubleUp: buildDoubleUpLineups(pool, { count, roster, rules: rules.double_up }),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
