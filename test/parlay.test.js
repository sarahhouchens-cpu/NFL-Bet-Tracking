import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTickets, validateTicket, isEligibleLeg, priceTicket, describeLeg,
  STAKE, MIN_PAYOUT, MIN_DECIMAL, LEG_COUNT, payoutBand, confidenceAdjusted,
} from '../lib/parlay.js';
import { correlationAdjustment, legCorrelation } from '../lib/correlation.js';

const leg = (over = {}) => ({
  playerId: over.playerId ?? `p${Math.random()}`,
  playerName: over.playerName ?? 'A Player',
  gameId: over.gameId ?? 'g1',
  team: over.team ?? 'KC',
  stat: over.stat ?? 'recYards',
  marketKey: over.marketKey ?? 'player_reception_yds',
  line: over.line ?? 40.5,
  americanOdds: over.americanOdds ?? 110,
  modelProbability: over.modelProbability ?? 0.5,
  edge: over.edge ?? 2,
  ...over,
});

/**
 * A realistic candidate pool: every leg in its own game, and markets varied so
 * the concentration rule is not what is being tested by accident.
 */
const MARKETS = [
  ['recYards', 'player_reception_yds'],
  ['receptions', 'player_receptions'],
  ['rushYards', 'player_rush_yds'],
  ['passYards', 'player_pass_yds'],
];

const pool = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => {
    const [stat, marketKey] = MARKETS[i % MARKETS.length];
    return leg({
      playerId: `p${i}`,
      playerName: `Player ${i}`,
      gameId: `g${i}`,
      team: `T${i}`,
      stat,
      marketKey,
      ...over,
    });
  });

test('the brief is encoded: $5 must return at least $100', () => {
  assert.equal(STAKE, 5);
  assert.equal(MIN_PAYOUT, 100);
  assert.equal(MIN_DECIMAL, 20);
});

test('every ticket built clears the payout floor', () => {
  const tickets = buildTickets(pool(9), { limit: 6 });
  assert.ok(tickets.length > 0, 'the pool should produce tickets');
  for (const ticket of tickets) {
    assert.ok(ticket.payout >= MIN_PAYOUT, `${ticket.payout} short of the floor`);
    assert.ok(ticket.legs.length >= LEG_COUNT.min && ticket.legs.length <= LEG_COUNT.max);
  }
});

test('short prices are refused because they cannot pay their way', () => {
  assert.equal(isEligibleLeg(leg({ americanOdds: -400 })), false);
  assert.equal(isEligibleLeg(leg({ americanOdds: -110 })), true);
});

test('an implausible edge is treated as an error, not an opportunity', () => {
  // A twenty-point edge on a liquid market means the model and the book are
  // pricing different things — and it is exactly what an EV sort chases.
  assert.equal(isEligibleLeg(leg({ edge: 25 })), false);
  assert.equal(isEligibleLeg(leg({ edge: -25 })), false);
  assert.equal(isEligibleLeg(leg({ edge: 5 })), true);
  // An unmeasured edge is unknown, not disqualifying.
  assert.equal(isEligibleLeg(leg({ edge: null })), true);
});

test('a near-certain leg is assumed mismapped', () => {
  assert.equal(isEligibleLeg(leg({ modelProbability: 0.99 })), false);
  assert.equal(isEligibleLeg(leg({ modelProbability: 0.01 })), false);
});

test('first-touchdown markets never reach a ticket', () => {
  assert.equal(isEligibleLeg(leg({ marketKey: 'player_1st_td', stat: 'firstTd' })), false);
});

test('one player may only appear once on a ticket', () => {
  const legs = [
    leg({ playerId: 'same', gameId: 'g1' }),
    leg({ playerId: 'same', gameId: 'g2' }),
    leg({ playerId: 'other', gameId: 'g3' }),
  ];
  assert.equal(validateTicket(legs), false);
});

test('cross-game tickets allow only one leg per game', () => {
  const legs = [leg({ gameId: 'g1', playerId: 'a' }), leg({ gameId: 'g1', playerId: 'b' }), leg({ gameId: 'g2', playerId: 'c' })];
  assert.equal(validateTicket(legs, { maxPerGame: 1 }), false);
  assert.equal(validateTicket(legs, { maxPerGame: 2 }), true);
});

test('a ticket cannot be six of the same market', () => {
  // Six passing-yard overs is one bet on a high-scoring week bought six times.
  const legs = Array.from({ length: 4 }, (_, i) =>
    leg({ playerId: `p${i}`, gameId: `g${i}`, stat: 'passYards', marketKey: 'player_pass_yds' })
  );
  assert.equal(validateTicket(legs, { maxPerMarket: 3 }), false);
  assert.equal(validateTicket(legs.slice(0, 3), { maxPerMarket: 3 }), true);
});

test('touchdown legs are capped', () => {
  const legs = Array.from({ length: 3 }, (_, i) =>
    leg({ playerId: `p${i}`, gameId: `g${i}`, stat: 'anytimeTd', marketKey: 'player_anytime_td' })
  );
  assert.equal(validateTicket(legs, { maxTdLegs: 2 }), false);
});

test('the confidence haircut punishes long tickets hardest', () => {
  // Model error compounds with leg count, so an unproven model should be
  // trusted least on the tickets that need it most.
  const short = confidenceAdjusted(0.1, 3, 0);
  const long = confidenceAdjusted(0.1, 6, 0);
  assert.ok(short / 0.1 > long / 0.1);
  // A proven model pays no haircut at all.
  assert.equal(confidenceAdjusted(0.1, 6, 1), 0.1);
});

test('payout bands separate a short ticket from a lottery ticket', () => {
  assert.equal(payoutBand(150), 'short');
  assert.equal(payoutBand(300), 'medium');
  assert.equal(payoutBand(900), 'long');
});

test('the board offers different bets rather than one bet six times', () => {
  const tickets = buildTickets(pool(10), { limit: 6, maxLegRepeat: 2 });
  const seen = new Map();
  for (const ticket of tickets) {
    for (const l of ticket.legs) seen.set(l.playerId, (seen.get(l.playerId) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    assert.ok(count <= 2, `${id} appears on ${count} tickets`);
  }
});

test('a quarterback and his own receiver are credited as correlated', () => {
  const qb = leg({ playerId: 'qb', team: 'KC', gameId: 'g1', stat: 'passYards' });
  const wr = leg({ playerId: 'wr', team: 'KC', gameId: 'g1', stat: 'recYards' });
  assert.ok(legCorrelation(qb, wr) > 0, 'a stack is positively correlated');
  assert.ok(correlationAdjustment([qb, wr]) > 1, 'and is likelier than independence implies');
});

test('a quarterback and his own running back pull against each other', () => {
  const qb = leg({ playerId: 'qb', team: 'KC', gameId: 'g1', stat: 'passYards' });
  const rb = leg({ playerId: 'rb', team: 'KC', gameId: 'g1', stat: 'rushYards' });
  assert.ok(legCorrelation(qb, rb) < 0);
  assert.ok(correlationAdjustment([qb, rb]) < 1);
});

test('legs in different games are left independent', () => {
  const a = leg({ playerId: 'a', gameId: 'g1' });
  const b = leg({ playerId: 'b', gameId: 'g2' });
  assert.equal(legCorrelation(a, b), 0);
  assert.equal(correlationAdjustment([a, b]), 1);
});

test('a correlated ticket never claims a probability above its weakest leg', () => {
  const qb = leg({ playerId: 'qb', team: 'KC', gameId: 'g1', stat: 'passYards', modelProbability: 0.5 });
  const wr = leg({ playerId: 'wr', team: 'KC', gameId: 'g1', stat: 'recYards', modelProbability: 0.4 });
  const priced = priceTicket([qb, wr]);
  assert.ok(priced.probability <= 0.4 + 1e-9, 'Fréchet bound holds');
  assert.ok(priced.probability > 0.2, 'but beats the independent product');
});

test('a ticket knows whether it is a spread or a stack', () => {
  const spread = priceTicket([leg({ playerId: 'a', gameId: 'g1' }), leg({ playerId: 'b', gameId: 'g2' })]);
  assert.equal(spread.style, 'spread');
  const stack = priceTicket([leg({ playerId: 'a', gameId: 'g1' }), leg({ playerId: 'b', gameId: 'g1' })]);
  assert.equal(stack.style, 'stack');
});

test('legs describe themselves the way a slip reads', () => {
  assert.equal(
    describeLeg(leg({ playerName: 'A Player', marketKey: 'player_reception_yds', line: 40.5 })),
    'A Player over 40.5 receiving yards'
  );
  assert.equal(
    describeLeg(leg({ playerName: 'A Player', marketKey: 'player_anytime_td', line: null })),
    'A Player to score a TD'
  );
});
