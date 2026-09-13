import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The tracker module reads localStorage at import time through load(), so a
 * minimal stand-in is installed before importing it. The arithmetic underneath
 * is pure and is what these tests are actually about.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const { parseBet, profitOf, summarize, bankrollCurve, payoutOf, load, save } = await import('../assets/tracker.js');

const bet = (over = {}) => ({
  id: over.id ?? 'x',
  description: 'a bet',
  date: over.date ?? '2026-09-01',
  type: over.type ?? 'prop',
  odds: over.odds ?? -110,
  stake: over.stake ?? 10,
  result: over.result ?? 'open',
  loggedAt: over.loggedAt ?? '2026-09-01T00:00:00Z',
  ...over,
});

test('a winning bet returns its price, a losing one its stake', () => {
  assert.ok(Math.abs(profitOf(bet({ result: 'won', odds: -110, stake: 10 })) - 9.0909) < 1e-3);
  assert.equal(profitOf(bet({ result: 'lost', stake: 10 })), -10);
  assert.equal(profitOf(bet({ result: 'won', odds: 240, stake: 5 })), 12);
});

test('a push is zero, not a loss and not a win', () => {
  // Counting pushes as losses is the commonest way a tracked record ends up
  // worse than the real one.
  assert.equal(profitOf(bet({ result: 'push' })), 0);
  assert.equal(profitOf(bet({ result: 'open' })), 0);
});

test('a push is excluded from the record and from return', () => {
  const s = summarize([
    bet({ id: '1', result: 'won', odds: 100, stake: 10 }),
    bet({ id: '2', result: 'push', stake: 10 }),
  ]);
  assert.equal(s.won, 1);
  assert.equal(s.lost, 0);
  assert.equal(s.pushed, 1);
  assert.equal(s.settled, 1);
  assert.equal(s.staked, 10, 'a pushed stake was never really at risk');
  assert.equal(s.roi, 1);
});

test('open bets are counted as exposure, not as performance', () => {
  // Including them in the denominator makes return drift when nothing happened.
  const s = summarize([
    bet({ id: '1', result: 'won', odds: 100, stake: 10 }),
    bet({ id: '2', result: 'open', stake: 25 }),
  ]);
  assert.equal(s.open, 1);
  assert.equal(s.openStake, 25);
  assert.equal(s.staked, 10);
  assert.equal(s.roi, 1);
});

test('nothing settled means no rate rather than a zero', () => {
  const s = summarize([bet({ result: 'open' })]);
  assert.equal(s.roi, null);
  assert.equal(s.winRate, null);
  assert.equal(s.breakEven, null);
});

test('break-even is what the prices taken actually demanded', () => {
  // A 50% record is good at +150 and terrible at -200; a bare win rate cannot
  // tell you which one you had.
  const s = summarize([
    bet({ id: '1', result: 'won', odds: -200, stake: 10 }),
    bet({ id: '2', result: 'lost', odds: -200, stake: 10 }),
  ]);
  assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.breakEven - 0.6667) < 1e-3, 'those prices needed 66.7%');
  assert.ok(s.winRate < s.breakEven);
});

test('the running total adds up', () => {
  const s = summarize([
    bet({ id: '1', result: 'won', odds: -110, stake: 10 }),
    bet({ id: '2', result: 'lost', odds: -110, stake: 10 }),
    bet({ id: '3', result: 'won', odds: 240, stake: 5 }),
  ]);
  assert.ok(Math.abs(s.profit - 11.0909) < 1e-3);
  assert.equal(s.staked, 25);
});

test('the bankroll curve runs oldest first and only over settled bets', () => {
  const curve = bankrollCurve([
    bet({ id: '3', result: 'won', odds: 100, stake: 10, date: '2026-09-03', loggedAt: 'c' }),
    bet({ id: '1', result: 'lost', stake: 10, date: '2026-09-01', loggedAt: 'a' }),
    bet({ id: '2', result: 'open', stake: 10, date: '2026-09-02', loggedAt: 'b' }),
  ]);
  assert.equal(curve.length, 2);
  assert.deepEqual(curve.map((p) => p.date), ['2026-09-01', '2026-09-03']);
  assert.equal(curve[0].profit, -10);
  assert.equal(curve[1].profit, 0);
});

test('the payout shown is what the slip would show', () => {
  assert.equal(payoutOf(bet({ odds: 1900, stake: 5 })), 100);
});

test('a price between -100 and +100 is refused', () => {
  // It looks like an ordinary number and would sail into payout arithmetic.
  assert.match(parseBet({ description: 'x', odds: '50', stake: '5' }).error, /not a valid American price/);
  assert.match(parseBet({ description: 'x', odds: '-99', stake: '5' }).error, /not a valid American price/);
  assert.match(parseBet({ description: 'x', odds: '0', stake: '5' }).error, /American price/);
});

test('a bet needs a description and a positive stake', () => {
  assert.match(parseBet({ description: '  ', odds: '-110', stake: '5' }).error, /description/);
  assert.match(parseBet({ description: 'x', odds: '-110', stake: '0' }).error, /positive/);
  assert.match(parseBet({ description: 'x', odds: '-110', stake: 'abc' }).error, /positive/);
});

test('a good bet parses and starts open', () => {
  const { bet: parsed, error } = parseBet({
    description: '  Chase over 72.5  ', odds: '+240', stake: '$5.00', date: '2026-09-14', type: 'prop', book: 'DraftKings',
  });
  assert.equal(error, undefined);
  assert.equal(parsed.description, 'Chase over 72.5');
  assert.equal(parsed.odds, 240);
  assert.equal(parsed.stake, 5);
  assert.equal(parsed.result, 'open');
  assert.ok(parsed.id);
});

test('a corrupt store costs this session, not every future one', () => {
  store.set('nfl-bet-tracking:bets:v1', 'not json at all');
  assert.deepEqual(load(), []);

  store.set('nfl-bet-tracking:bets:v1', JSON.stringify([{ nonsense: true }, bet({ id: 'ok' })]));
  const loaded = load();
  assert.equal(loaded.length, 1, 'entries without a usable price are dropped');
  assert.equal(loaded[0].id, 'ok');
});

test('saving and loading round-trips', () => {
  store.clear();
  assert.equal(save([bet({ id: 'a' })]), true);
  assert.equal(load().length, 1);
});
