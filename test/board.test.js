import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBoard, buildDfs, buildEvent, touchdownScale } from '../lib/board.js';
import { parseDkSalaries } from '../lib/salaries.js';
import { reconcilePlayer, reconcileTeam, capAdjustment, shrinkRate, MAX_ADJUSTMENT } from '../lib/reconcile.js';
import { MIN_PAYOUT } from '../lib/parlay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const load = async () => ({
  events: JSON.parse(await readFile(join(ROOT, 'data/demo-events.json'), 'utf8')),
  salaries: parseDkSalaries(await readFile(join(ROOT, 'data/demo-salaries.csv'), 'utf8')),
});

const teamMap = (salaries) => new Map(salaries.filter((r) => r.team).map((r) => [r.playerId, r.team]));

test('reconciliation never moves a projection further than its cap allows', () => {
  // The posted line is the best single estimate. A cross-check is a second
  // opinion, and without a cap the ratio arithmetic will happily conclude a
  // receiver priced at 8.5 yards should be projected for 16.
  assert.ok(Math.abs(capAdjustment(100, 200) - 115) < 1e-9);
  assert.ok(Math.abs(capAdjustment(100, 10) - 85) < 1e-9);
  assert.equal(capAdjustment(100, 105), 105);
  assert.equal(capAdjustment(0, 50), 50, 'nothing to anchor to');

  const player = reconcilePlayer({
    position: 'WR',
    projection: { receptions: 1.3, recYards: 9.4, carries: 0, rushYards: 0 },
  });
  assert.ok(player.projection.recYards <= 9.4 * (1 + MAX_ADJUSTMENT) + 1e-9);
  assert.ok(player.projection.recYards >= 9.4 * (1 - MAX_ADJUSTMENT) - 1e-9);
});

test('a rate is shrunk toward its position, not replaced by it', () => {
  // A receiver running deep routes is real information, not an error.
  const deep = shrinkRate(80, 4, 12.5); // implied 20 yards a catch
  assert.ok(deep > 12.5, 'kept some of his own rate');
  assert.ok(deep < 20, 'but shrunk toward the position');
});

test('a player whose lines already agree is left alone', () => {
  // If reconciliation moved a consistent player, every edge on the board would
  // be an artefact of the model rather than a disagreement in the market.
  const before = { receptions: 5, recYards: 62.5, carries: 0, rushYards: 0 };
  const after = reconcilePlayer({ position: 'WR', projection: { ...before } }).projection;
  assert.ok(Math.abs(after.recYards - before.recYards) < 1.5);
  assert.ok(Math.abs(after.receptions - before.receptions) < 0.3);
});

test('a stat with only one line posted is not reconciled against nothing', () => {
  const after = reconcilePlayer({
    position: 'WR',
    projection: { receptions: 0, recYards: 62.5, carries: 0, rushYards: 0 },
  }).projection;
  assert.equal(after.recYards, 62.5);
  assert.equal(after.receptions, 0);
});

test('a quarterback is squared against his own receivers', () => {
  const players = [
    { playerId: 'qb', position: 'QB', team: 'KC', projection: { passYards: 300, recYards: 0 } },
    { playerId: 'w1', position: 'WR', team: 'KC', projection: { recYards: 80 } },
    { playerId: 'w2', position: 'WR', team: 'KC', projection: { recYards: 60 } },
    { playerId: 'te', position: 'TE', team: 'KC', projection: { recYards: 45 } },
  ];
  const after = reconcileTeam(players);
  const qb = after.find((p) => p.playerId === 'qb');
  // Receivers charted at 185 imply about 195 passing yards, well under 300, so
  // the quarterback's projection should come down toward them.
  assert.ok(qb.projection.passYards < 300);
  assert.ok(qb.projection.passYards >= 300 * (1 - MAX_ADJUSTMENT) - 1e-9, 'but not past the cap');
  // And the receivers move the other way — the disagreement is split.
  assert.ok(after.find((p) => p.playerId === 'w1').projection.recYards > 80);
});

test('the touchdown market is devigged against the game total, not one leg', () => {
  // Ten players each priced at even money implies five scorers between them.
  const quotes = new Map(
    Array.from({ length: 10 }, (_, i) => [
      String(i),
      { marketKey: 'player_anytime_td', americanOdds: 100, oppositeAmericanOdds: null },
    ])
  );

  // A low-scoring game cannot support five touchdown scorers, so the market —
  // which has no second side to devig against — is scaled down toward what the
  // total implies.
  const tight = touchdownScale(quotes, 34);
  assert.ok(tight < 1, `expected scaling down, got ${tight}`);
  assert.ok(tight >= 0.5, 'but never below the clamp');

  // A shootout supports more scorers, so there is nothing to strip out. The
  // scale is capped at 1: this removes margin, it never invents probability.
  assert.equal(touchdownScale(quotes, 56), 1);
  assert.equal(touchdownScale(new Map(), 45), 1, 'no market, no scaling');
});

test('the fixture builds a board end to end', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });

  assert.equal(board.games.length, events.length);
  assert.ok(board.players.length > 100, 'players were projected');
  assert.ok(board.legCount > 100, 'candidate legs were produced');
  assert.equal(board.stake, 5);
  assert.equal(board.minPayout, MIN_PAYOUT);
});

test('every ticket on a real board clears $100 and is internally consistent', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });

  assert.ok(board.tickets.length > 0, 'the fixture should produce tickets');
  for (const ticket of board.tickets) {
    assert.ok(ticket.payout >= MIN_PAYOUT);
    assert.ok(ticket.probability > 0 && ticket.probability < 1);
    // Cross-game tickets must genuinely be cross-game, or the quoted price is
    // not one any book would offer.
    assert.equal(ticket.style, 'spread');
    assert.equal(new Set(ticket.legs.map((l) => l.gameId)).size, ticket.legs.length);
    // The payout must equal the legs multiplied out.
    const decimal = ticket.legs.reduce(
      (acc, l) => acc * (l.americanOdds > 0 ? 1 + l.americanOdds / 100 : 1 + 100 / Math.abs(l.americanOdds)),
      1
    );
    assert.ok(Math.abs(ticket.payout - 5 * decimal) < 1e-6, 'payout does not match the legs');
    for (const legLine of ticket.legs) assert.ok(legLine.description.length > 0);
  }
});

test('no leg on the board claims an implausible edge', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });
  for (const ticket of [...board.tickets, ...board.stacks]) {
    for (const legLine of ticket.legs) {
      if (legLine.edge != null) assert.ok(Math.abs(legLine.edge) <= 12, `edge of ${legLine.edge}`);
    }
  }
});

test('same-game stacks really are same-game', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });
  for (const stack of board.stacks) {
    assert.equal(stack.gameCount, 1);
    assert.equal(stack.style, 'stack');
  }
});

test('the fixture builds DraftKings lineups for every slate', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });
  const dfs = buildDfs(board, salaries, { count: 3 });

  assert.equal(dfs.salarySource, 'draftkings');
  assert.ok(dfs.slates.length >= 3, 'the fixture week should make several slates');

  for (const slate of dfs.slates) {
    assert.ok(slate.tournament.length > 0, `${slate.slate.name} has no tournament lineup`);
    assert.ok(slate.doubleUp.length > 0, `${slate.slate.name} has no double-up lineup`);
    for (const lineup of [...slate.tournament, ...slate.doubleUp]) {
      assert.ok(lineup.salary <= 50000);
      assert.ok(lineup.players.every((p) => p.gameId && p.salary > 0));
    }
  }
});

test('a kicker never takes a roster spot it cannot fill', async () => {
  const { events, salaries } = await load();
  const board = buildBoard(events, { teamByPlayer: teamMap(salaries) });
  const dfs = buildDfs(board, salaries, { count: 2 });
  for (const slate of dfs.slates) {
    for (const lineup of [...slate.tournament, ...slate.doubleUp]) {
      assert.ok(lineup.players.every((p) => p.position !== 'K'));
    }
  }
});

test('both defences are projected for every game', async () => {
  const { events } = await load();
  const built = buildEvent(events[0], { teamByPlayer: new Map() });
  const defences = built.players.filter((p) => p.position === 'DST');
  assert.equal(defences.length, 2);
  assert.ok(defences.every((d) => d.points > 0 && d.ceiling > d.floor));
});
