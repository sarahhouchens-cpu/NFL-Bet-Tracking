/**
 * Assembles a raw odds snapshot into the two things the site shows: the value
 * board and the DraftKings player pool.
 *
 * Kept apart from the fetching so the whole pipeline can be exercised against a
 * fixture. Every number the site displays is produced here, which means a test
 * can catch a wrong one without spending an API credit.
 */

import { parsePlayerProps, parseGameLines, normalizeName, PLAYER_MARKETS } from './markets.js';
import { projectPlayer, projectDefense, fairProbability, rescore } from './projections.js';
import { probabilityOver } from './distribution.js';
import { buildTickets, buildStacks, describeLeg, STAKE, MIN_PAYOUT } from './parlay.js';
import { attachSalaries } from './salaries.js';
import { reconcileGame } from './reconcile.js';
import { buildSlates } from './slates.js';
import { recommendForSlate } from './lineups.js';

/**
 * Average touchdowns scored by both teams in a game, per point of total.
 *
 * A 44-point game produces about five touchdowns between the two teams. This is
 * what the anytime-touchdown market gets devigged against — the sum of every
 * listed player's "yes" price far exceeds the real number of scorers, and the
 * gap is the book's margin.
 */
const TOUCHDOWNS_PER_POINT = 5 / 44;

/**
 * Work out how much to shrink an anytime-touchdown market by.
 *
 * The listed prices imply a certain number of scorers; the game total implies
 * another, smaller one. The ratio is the correction. Clamped because a sparse
 * market — a book that has posted only three players so far — would otherwise
 * scale those three up absurdly.
 */
export function touchdownScale(quotes, gameTotal) {
  const anytime = [...quotes.values()].filter((q) => q.marketKey === 'player_anytime_td');
  if (!anytime.length || !Number.isFinite(gameTotal)) return 1;

  const impliedScorers = anytime.reduce((sum, q) => sum + fairProbability(q).probability, 0);
  if (impliedScorers <= 0) return 1;

  // Only offensive players are listed, and a few touchdowns are scored by
  // defences or on returns, so the expected number of listed scorers is a
  // little under the game's touchdown count.
  const expected = gameTotal * TOUCHDOWNS_PER_POINT * 0.92;
  return Math.min(1, Math.max(0.5, expected / impliedScorers));
}

/**
 * Build every projection and candidate bet leg from one event.
 *
 * `team` is attached to each player by matching the prop feed against the
 * game's two teams — the prop payload does not say which side a player is on,
 * and without that the correlation model cannot tell a stack from two unrelated
 * legs.
 */
export function buildEvent(event, options = {}) {
  const { teamByPlayer = new Map() } = options;

  const quotes = parsePlayerProps(event);
  const lines = parseGameLines(event);
  const scale = touchdownScale(quotes, lines.total);

  const byPlayer = new Map();
  for (const quote of quotes.values()) {
    const id = normalizeName(quote.playerName);
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push(quote);
  }

  const players = [];
  for (const [id, playerQuotes] of byPlayer) {
    const projected = projectPlayer(playerQuotes[0].playerName, playerQuotes, {
      gameTouchdownScale: scale,
    });
    players.push({
      ...projected,
      gameId: lines.gameId,
      team: teamByPlayer.get(id) ?? null,
      opponent: null,
    });
  }

  // Square the projections against each other before anything is priced from
  // them. This is what lets the model disagree with a line rather than merely
  // restate it. Every derived number is then recomputed, because the stat line
  // it was derived from has just changed.
  const roster = reconcileGame(players).map(rescore);

  // Both defences, priced off the opposing team's implied total.
  for (const team of [lines.home, lines.away]) {
    if (!team) continue;
    const opponent = team === lines.home ? lines.away : lines.home;
    const opponentTotal = lines.teamTotals[opponent];
    if (!Number.isFinite(opponentTotal)) continue;
    const spread = team === lines.home ? lines.homeSpread : -lines.homeSpread;
    roster.push({
      ...projectDefense(team, opponentTotal, spread),
      gameId: lines.gameId,
      team,
      opponent,
    });
  }

  return { lines, players: roster, quotes };
}

/**
 * Turn one player's quotes into candidate legs the ticket builder can rank.
 *
 * The model probability is *not* the book's own devigged number — that would
 * make every edge exactly zero. It is the probability the fitted projection
 * gives the same threshold, which differs from the book's whenever this
 * player's other lines disagree with the one being priced. That disagreement is
 * the entire signal: a receiver whose reception line implies more volume than
 * his yardage line does is mispriced on one of the two.
 */
export function candidateLegs(player, event) {
  const legs = [];

  for (const quote of event.quotes.values()) {
    if (normalizeName(quote.playerName) !== player.playerId) continue;

    const spec = PLAYER_MARKETS[quote.marketKey];
    if (!spec) continue;

    const { probability: fair, devigged } = fairProbability(quote);

    let modelProbability;
    if (spec.kind === 'yes_no') {
      // A touchdown price has no second side to disagree with, so the model
      // has nothing independent to say and takes the scaled market number.
      modelProbability = player.anytimeTd ?? null;
    } else {
      const mean = player.projection[statField(spec.stat)] ?? 0;
      if (!(mean > 0)) continue;
      modelProbability = probabilityOver(quote.line, mean, spec.stat);
    }

    if (!Number.isFinite(modelProbability) || modelProbability <= 0) continue;

    legs.push({
      playerId: player.playerId,
      playerName: player.playerName,
      position: player.position,
      team: player.team,
      gameId: event.lines.gameId,
      marketKey: quote.marketKey,
      stat: spec.stat,
      label: spec.label,
      line: quote.line,
      americanOdds: quote.americanOdds,
      oppositeAmericanOdds: quote.oppositeAmericanOdds,
      book: quote.book,
      modelProbability,
      fairProbability: devigged ? fair : null,
      // Without a second side there is no fair price to measure against, and an
      // edge computed against a vigged one flatters itself.
      edge: devigged ? (modelProbability - fair) * 100 : null,
    });
  }

  return legs;
}

/** Projection field backing each market's stat. */
function statField(stat) {
  return stat === 'carries' ? 'carries' : stat;
}

/**
 * Build the whole board from a snapshot of events.
 *
 * A snapshot is what the fetch script writes: the raw event payloads, exactly
 * as The Odds API returned them. Everything after this point is deterministic,
 * so the same snapshot always produces the same board.
 */
export function buildBoard(events, options = {}) {
  const { confidence = 0, limit = 6, teamByPlayer = new Map(), demo = false } = options;

  const games = [];
  const allPlayers = [];
  const allLegs = [];

  for (const event of events) {
    const built = buildEvent(event, { teamByPlayer });
    if (!built.lines.gameId) continue;

    games.push(built.lines);

    for (const player of built.players) {
      allPlayers.push(player);
      if (player.position === 'DST') continue;
      allLegs.push(...candidateLegs(player, built));
    }
  }

  const tickets = buildTickets(allLegs, { confidence, limit, maxPerGame: 1 });
  const stacks = buildStacks(allLegs, { confidence, limit: 3 });

  return {
    generatedAt: new Date().toISOString(),
    // Carried all the way through to the page. A board built from the fixture
    // contains invented players, and letting those render as though they were
    // real recommendations is the most misleading thing this repo could do.
    demo,
    stake: STAKE,
    minPayout: MIN_PAYOUT,
    games,
    players: allPlayers,
    legCount: allLegs.length,
    tickets: tickets.map(describeTicket),
    stacks: stacks.map(describeTicket),
  };
}

/** Flatten a ticket into the shape the page renders. */
export function describeTicket(ticket) {
  return {
    ...ticket,
    legs: ticket.legs.map((leg) => ({
      ...leg,
      description: describeLeg(leg),
    })),
  };
}

/**
 * Build DraftKings recommendations for every slate the week produces.
 *
 * Kickers are dropped: DraftKings classic rosters have no kicker slot, and
 * leaving them in the pool only lets one take a flex spot it can never fill.
 */
export function buildDfs(board, salaryRows = [], options = {}) {
  const { count = 3, demo = false } = options;

  const slates = buildSlates(board.games);
  const priced = attachSalaries(
    board.players.filter((p) => p.position !== 'K' && p.position !== 'FLEX'),
    salaryRows
  );

  const salarySource = priced.find((p) => p.salarySource)?.salarySource ?? 'estimated';

  const recommendations = [];
  const skipped = [];

  for (const slate of slates) {
    const gameIds = new Set(slate.games.map((g) => g.gameId));
    const pool = priced.filter((p) => gameIds.has(p.gameId));

    if (pool.length < (slate.format === 'showdown' ? 8 : 30)) {
      skipped.push({ name: slate.name, reason: 'too few players priced — props are not posted for these games yet' });
      continue;
    }

    // A classic roster has named position slots, and positions inferred from
    // prop lines cannot distinguish a tight end from a receiver. Filling a TE
    // slot with someone who is not a tight end produces a lineup DraftKings
    // will not accept, so the slate is skipped and said so rather than built
    // wrong. Showdown has no position requirements and is unaffected.
    if (slate.format === 'classic' && !pool.some((p) => p.position === 'TE')) {
      skipped.push({ name: slate.name, reason: 'no tight ends identified — add a DKSalaries.csv for real positions' });
      continue;
    }

    recommendations.push(recommendForSlate(pool, slate, { count }));
  }

  return {
    generatedAt: new Date().toISOString(),
    demo,
    salarySource,
    slates: recommendations,
    skipped,
  };
}
