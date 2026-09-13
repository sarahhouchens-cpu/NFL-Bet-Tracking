import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recommendForSlate, fillRoster, assignLocked, lineupRange, playerCorrelation,
  playerScore, describeStack, feasibleRules, selectDiverse, CONTEST_RULES,
} from '../lib/lineups.js';
import { CLASSIC_ROSTER, SHOWDOWN_ROSTER, SALARY_CAP } from '../lib/scoring.js';
import { projectOwnership, leverage } from '../lib/ownership.js';

/** A deterministic slate: six games, twelve teams, eight players each. */
function makePool() {
  const games = [['g1','KC','BUF'],['g2','PHI','DAL'],['g3','SF','SEA'],
                 ['g4','CIN','BAL'],['g5','DET','GB'],['g6','MIA','NYJ']];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pool = [];

  for (const [gameId, home, away] of games) {
    for (const team of [home, away]) {
      const strength = 0.85 + rnd() * 0.4;
      const add = (suffix, position, salary, points, ceilingRatio) =>
        pool.push({
          playerId: `${team}-${suffix}`.toLowerCase(),
          playerName: `${team} ${suffix}`,
          position, team, gameId,
          salary: Math.round(salary / 100) * 100,
          points: Math.round(points * strength * 10) / 10,
          floor: Math.round(points * strength * 0.5 * 10) / 10,
          ceiling: Math.round(points * strength * ceilingRatio * 10) / 10,
        });

      add('QB', 'QB', 5200 + rnd() * 2600, 16, 1.7);
      add('RB1', 'RB', 4400 + rnd() * 3200, 12, 1.9);
      add('RB2', 'RB', 3600 + rnd() * 1000, 7, 2.1);
      add('WR1', 'WR', 5000 + rnd() * 3000, 13, 2.0);
      add('WR2', 'WR', 4000 + rnd() * 1800, 9, 2.1);
      add('WR3', 'WR', 3200 + rnd() * 1000, 6, 2.3);
      add('TE', 'TE', 3000 + rnd() * 2600, 8, 2.0);
      add('DST', 'DST', 2400 + rnd() * 1200, 7, 1.9);
    }
  }
  return pool;
}

const CLASSIC_SLATE = { id: 'main', name: 'Sunday Main', format: 'classic', startsAt: '2026-09-20T17:00:00Z' };

test('every recommended lineup is legal', () => {
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  const all = [...rec.tournament, ...rec.doubleUp];
  assert.ok(all.length >= 4, 'both styles should produce lineups');

  for (const lineup of all) {
    assert.equal(lineup.players.length, 9);
    assert.ok(lineup.salary <= SALARY_CAP, `over the cap at ${lineup.salary}`);

    // No player twice.
    const ids = lineup.players.map((p) => p.playerId);
    assert.equal(new Set(ids).size, 9, 'a player appears twice');

    // Every slot filled by an eligible position.
    for (const slot of CLASSIC_ROSTER) {
      const filled = lineup.players.find((p) => p.slot === slot.slot);
      assert.ok(filled, `${slot.slot} unfilled`);
      assert.ok(slot.eligible.includes(filled.position), `${filled.position} cannot play ${slot.slot}`);
    }
  }
});

test('a double-up lineup refuses to stack a quarterback with his own receiver', () => {
  // Cash upside past the cut pays nothing, so the shared downside is all cost.
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  for (const lineup of rec.doubleUp) {
    const qb = lineup.players.find((p) => p.position === 'QB');
    const stacked = lineup.players.filter(
      (p) => p.team === qb.team && ['WR', 'TE'].includes(p.position)
    );
    assert.equal(stacked.length, 0, 'cash lineup stacked its quarterback');
    assert.equal(lineup.stack, null);
  }
});

test('a tournament lineup is built around a stack', () => {
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  for (const lineup of rec.tournament) {
    assert.ok(lineup.stack, 'tournament lineup has no stack');
    assert.ok(lineup.stack.size >= 2);
  }
});

test('tournament lineups carry more variance than double-up lineups', () => {
  // This is the whole point of building them separately: correlated players do
  // not diversify each other away, so the total keeps its spread.
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  const gpp = rec.tournament[0];
  const cash = rec.doubleUp[0];
  assert.ok(gpp.sd > cash.sd, `gpp sd ${gpp.sd} should exceed cash sd ${cash.sd}`);
  assert.ok(cash.floor > gpp.floor, `cash floor ${cash.floor} should exceed gpp floor ${gpp.floor}`);
});

test('a defence is never rostered against an offence you own', () => {
  // On a full slate there are always enough bodies to avoid it. The rule is
  // deliberately relaxed on slates too small to fill a roster otherwise, which
  // the small-slate test below covers.
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  for (const lineup of [...rec.tournament, ...rec.doubleUp]) {
    const dst = lineup.players.find((p) => p.position === 'DST');
    const opposed = lineup.players.filter(
      (p) => p.position !== 'DST' && p.gameId === dst.gameId && p.team !== dst.team
    );
    assert.equal(opposed.length, 0, 'rostered a defence against your own player');
  }
});

test('a lineup total is not the sum of nine individual ceilings', () => {
  // Nine players independently having their best game is not a real afternoon,
  // and treating it as one would rank scattered boom plays above a real stack.
  const players = makePool().slice(0, 9);
  const range = lineupRange(players);
  const naive = players.reduce((sum, p) => sum + p.ceiling, 0);
  assert.ok(range.ceiling < naive, 'diversification was ignored');
  assert.ok(range.ceiling > range.mean);
  assert.ok(range.floor < range.mean);
});

test('correlated players widen a lineup, uncorrelated ones narrow it', () => {
  const base = { salary: 5000, points: 15, floor: 7, ceiling: 30 };
  const stacked = [
    { ...base, playerId: 'a', position: 'QB', team: 'KC', gameId: 'g1' },
    { ...base, playerId: 'b', position: 'WR', team: 'KC', gameId: 'g1' },
    { ...base, playerId: 'c', position: 'WR', team: 'KC', gameId: 'g1' },
  ];
  const scattered = [
    { ...base, playerId: 'a', position: 'QB', team: 'KC', gameId: 'g1' },
    { ...base, playerId: 'b', position: 'WR', team: 'PHI', gameId: 'g2' },
    { ...base, playerId: 'c', position: 'WR', team: 'SF', gameId: 'g3' },
  ];

  assert.equal(lineupRange(stacked).mean, lineupRange(scattered).mean, 'same expected points');
  assert.ok(lineupRange(stacked).sd > lineupRange(scattered).sd, 'stack should be wider');
  assert.ok(lineupRange(stacked).ceiling > lineupRange(scattered).ceiling);
  assert.ok(lineupRange(stacked).floor < lineupRange(scattered).floor);
});

test('correlation signs match how football works', () => {
  const at = (position, team, gameId) => ({ position, team, gameId, playerId: `${team}${position}` });
  assert.ok(playerCorrelation(at('QB','KC','g1'), at('WR','KC','g1')) > 0.5, 'stack');
  assert.ok(playerCorrelation(at('QB','KC','g1'), at('WR','BUF','g1')) > 0, 'bring-back');
  assert.ok(playerCorrelation(at('DST','KC','g1'), at('WR','BUF','g1')) < 0, 'defence against that offence');
  assert.ok(playerCorrelation(at('DST','KC','g1'), at('WR','KC','g1')) > 0, 'defence with its own offence');
  assert.equal(playerCorrelation(at('QB','KC','g1'), at('WR','PHI','g2')), 0, 'different games');
});

test('showdown builds a captain and five flex from one game', () => {
  const pool = makePool().filter((p) => p.gameId === 'g1');
  const rec = recommendForSlate(pool, { id: 'sd', name: 'Showdown', format: 'showdown', startsAt: 'x' }, { count: 2 });
  const all = [...rec.tournament, ...rec.doubleUp];
  assert.ok(all.length >= 2, 'showdown produced no lineups');

  for (const lineup of all) {
    assert.equal(lineup.players.length, 6);
    assert.ok(lineup.salary <= SALARY_CAP);
    const captains = lineup.players.filter((p) => p.multiplier === 1.5);
    assert.equal(captains.length, 1, 'exactly one captain');
    assert.equal(lineup.players[0].slot, 'CPT');
    assert.equal(new Set(lineup.players.map((p) => p.playerId)).size, 6);
  }
});

test('the captain multiplier is actually applied to the score', () => {
  const pool = makePool().filter((p) => p.gameId === 'g1');
  const rec = recommendForSlate(pool, { id: 'sd', name: 'Showdown', format: 'showdown', startsAt: 'x' }, { count: 1 });
  const lineup = rec.tournament[0];
  const plain = lineup.players.reduce((sum, p) => sum + p.points, 0);
  assert.ok(lineup.points > plain, 'captain scored at 1x');
});

test('team limits relax only as far as a small slate requires', () => {
  // Two games is four teams; a nine-man roster capped at two per team can only
  // ever reach eight, so the optimiser would return nothing at all.
  const small = makePool().filter((p) => ['g1', 'g2'].includes(p.gameId));
  const relaxed = feasibleRules(CONTEST_RULES.double_up, CLASSIC_ROSTER, small);
  assert.ok(relaxed.maxPerTeam >= 3, 'limit stayed unsatisfiable');

  const full = feasibleRules(CONTEST_RULES.double_up, CLASSIC_ROSTER, makePool());
  assert.equal(full.maxPerTeam, CONTEST_RULES.double_up.maxPerTeam, 'a full slate keeps the strict limit');
});

test('a small slate still produces lineups', () => {
  const small = makePool().filter((p) => ['g1', 'g2', 'g3'].includes(p.gameId));
  const rec = recommendForSlate(small, CLASSIC_SLATE, { count: 2 });
  assert.ok(rec.doubleUp.length > 0, 'no cash lineup on a three-game slate');
  assert.ok(rec.tournament.length > 0, 'no tournament lineup on a three-game slate');
});

test('locked players are given slots before the search runs', () => {
  const assigned = assignLocked(CLASSIC_ROSTER, [
    { playerId: 'qb', position: 'QB' },
    { playerId: 'te', position: 'TE' },
    { playerId: 'wr', position: 'WR' },
  ]);
  assert.ok(assigned);
  assert.equal(assigned.size, 3);
  // The tight end must take TE, not the FLEX that the receiver could also use.
  const slots = [...assigned.entries()].map(([index, player]) => [CLASSIC_ROSTER[index].slot, player.playerId]);
  assert.ok(slots.some(([slot, id]) => slot === 'TE' && id === 'te'));
  assert.ok(slots.some(([slot, id]) => slot === 'QB' && id === 'qb'));
});

test('locked players actually appear in the built lineup', () => {
  // Filtering for them after the fact silently drops the stack whenever it was
  // not also the best value, which is exactly when forcing it mattered.
  const pool = makePool();
  const qb = pool.find((p) => p.playerId === 'kc-qb');
  const wr = pool.find((p) => p.playerId === 'kc-wr3');
  const built = fillRoster(CLASSIC_ROSTER, pool, {
    contest: 'tournament',
    locked: [qb, wr],
    rules: CONTEST_RULES.tournament,
    collect: 5,
  });

  assert.ok(built.length > 0);
  for (const lineup of built) {
    assert.ok(lineup.players.some((p) => p.playerId === 'kc-qb'));
    assert.ok(lineup.players.some((p) => p.playerId === 'kc-wr3'));
    assert.ok(lineup.salary <= SALARY_CAP);
  }
});

test('an unaffordable lock returns nothing rather than a busted lineup', () => {
  const pool = makePool();
  const expensive = pool.slice(0, 3).map((p) => ({ ...p, salary: 20000 }));
  const built = fillRoster(CLASSIC_ROSTER, [...expensive, ...pool], {
    contest: 'tournament',
    locked: expensive,
    rules: CONTEST_RULES.tournament,
  });
  assert.equal(built.length, 0);
});

test('multiple lineups differ from each other', () => {
  const rec = recommendForSlate(makePool(), CLASSIC_SLATE, { count: 3 });
  for (const style of [rec.tournament, rec.doubleUp]) {
    for (let i = 0; i < style.length; i++) {
      for (let j = i + 1; j < style.length; j++) {
        const a = new Set(style[i].players.map((p) => p.playerId));
        const shared = style[j].players.filter((p) => a.has(p.playerId)).length;
        assert.ok(9 - shared >= 2, 'two lineups are near-identical');
      }
    }
  }
});

test('the tournament objective prefers a leveraged player to an owned one', () => {
  const owned = { points: 15, floor: 8, ceiling: 28, ownership: 40, salary: 6000 };
  const contrarian = { points: 15, floor: 8, ceiling: 28, ownership: 4, salary: 6000 };
  assert.ok(playerScore(contrarian, 'tournament') > playerScore(owned, 'tournament'));
  // A cash lineup does not care who else is on the player.
  assert.equal(playerScore(contrarian, 'double_up'), playerScore(owned, 'double_up'));
  assert.ok(leverage(contrarian) > leverage(owned));
});

test('projected ownership sums to the seats a position fills', () => {
  const owned = projectOwnership(makePool());
  const quarterbacks = owned.filter((p) => p.position === 'QB');
  const total = quarterbacks.reduce((sum, p) => sum + p.ownership, 0);
  // One quarterback slot means all quarterbacks together are rostered once.
  assert.ok(total > 80 && total < 120, `quarterback ownership summed to ${total}`);
  assert.ok(owned.every((p) => p.ownership > 0 && p.ownership <= 65));
});

test('a stack describes itself', () => {
  const players = [
    { playerId: 'qb', playerName: 'The QB', position: 'QB', team: 'KC', gameId: 'g1' },
    { playerId: 'wr', playerName: 'The WR', position: 'WR', team: 'KC', gameId: 'g1' },
    { playerId: 'br', playerName: 'The Back', position: 'WR', team: 'BUF', gameId: 'g1' },
  ];
  const stack = describeStack(players);
  assert.match(stack.label, /The QB \+ The WR/);
  assert.match(stack.label, /back with The Back/);
  assert.equal(stack.bringBack, 1);
  assert.equal(describeStack([{ position: 'RB', team: 'KC' }]), null);
});

test('diversity selection respects exposure caps', () => {
  const lineup = (ids) => ({ players: ids.map((id) => ({ playerId: id })), points: 100, floor: 60, ceiling: 150 });
  const candidates = [
    lineup(['a','b','c','d','e','f','g','h','i']),
    lineup(['a','b','c','d','e','f','g','h','j']),
    lineup(['k','l','m','n','o','p','q','r','s']),
  ];
  const chosen = selectDiverse(candidates, { count: 2, rules: CONTEST_RULES.tournament, sortKey: 'ceiling' });
  // The second differs from the first by one player, so it must be skipped.
  assert.equal(chosen.length, 2);
  assert.ok(chosen[1].players.some((p) => p.playerId === 'k'));
});
