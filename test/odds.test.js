import test from 'node:test';
import assert from 'node:assert/strict';

import {
  americanToDecimal, decimalToAmerican, formatAmerican, isValidAmerican,
  devig, devigMultiway, parlayDecimal, payout, profit, parlayProbability,
  expectedValue, breakEvenRate, impliedProbability,
} from '../lib/odds.js';

test('American and decimal convert both ways', () => {
  assert.equal(americanToDecimal(100), 2);
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(-200), 1.5);
  assert.ok(Math.abs(americanToDecimal(-110) - 1.909090909) < 1e-6);

  assert.equal(decimalToAmerican(2), 100);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
});

test('a price of zero is rejected rather than converted', () => {
  // Number(null) and Number('') are both 0 and both pass isFinite, so a naive
  // check lets a missing price through into payout arithmetic.
  assert.equal(isValidAmerican(null), false);
  assert.equal(isValidAmerican(''), false);
  assert.equal(isValidAmerican(0), false);
  assert.equal(isValidAmerican(-110), true);
  assert.throws(() => americanToDecimal(0));
});

test('formatting shows the sign a book would', () => {
  assert.equal(formatAmerican(150), '+150');
  assert.equal(formatAmerican(-110), '-110');
});

test('devig strips the margin and leaves probabilities summing to one', () => {
  const fair = devig([americanToDecimal(-120), americanToDecimal(-110)]);
  assert.ok(Math.abs(fair[0] + fair[1] - 1) < 1e-12);
  // The favourite stays the favourite.
  assert.ok(fair[0] > fair[1]);
});

test('a two-sided market at equal prices devigs to a coin flip', () => {
  const fair = devig([americanToDecimal(-110), americanToDecimal(-110)]);
  assert.ok(Math.abs(fair[0] - 0.5) < 1e-12);
});

test('multiway devig scales a one-sided field to the winners it expects', () => {
  // An anytime-touchdown market: every player posted as a "yes" with no "no"
  // beside them, so the prices together imply far more scorers than the game
  // will actually produce. Here they imply 1.48; the total says 1.2.
  const prices = [2.0, 2.5, 4.0, 3.0];
  const raw = prices.reduce((sum, d) => sum + impliedProbability(d), 0);
  assert.ok(raw > 1.2, 'the posted prices should imply more than the truth');

  const fair = devigMultiway(prices, 1.2);
  const total = fair.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1.2) < 1e-9);
  // Order is preserved: the shortest price stays the likeliest scorer.
  assert.ok(fair[0] > fair[1] && fair[1] > fair[3] && fair[3] > fair[2]);
});

test('multiway devig never returns an impossible probability', () => {
  // A heavy favourite in a sparse market would otherwise scale past 1.
  const fair = devigMultiway([1.05, 8.0], 2);
  assert.ok(fair.every((p) => p > 0 && p < 1));
});

test('$5 at +1900 returns exactly $100', () => {
  const decimal = americanToDecimal(1900);
  assert.equal(payout(5, decimal), 100);
  assert.equal(profit(5, decimal), 95);
});

test('parlay odds multiply', () => {
  const legs = [{ americanOdds: 100 }, { americanOdds: 100 }];
  assert.equal(parlayDecimal(legs), 4);
  assert.throws(() => parlayDecimal([]));
});

test('same-game legs are shaded down, different-game legs are not', () => {
  const spread = [
    { modelProbability: 0.5, gameId: 'a' },
    { modelProbability: 0.5, gameId: 'b' },
  ];
  assert.equal(parlayProbability(spread), 0.25);

  const shared = [
    { modelProbability: 0.5, gameId: 'a' },
    { modelProbability: 0.5, gameId: 'a' },
  ];
  assert.ok(parlayProbability(shared) < 0.25);
});

test('expected value is positive only when the price beats the probability', () => {
  const decimal = americanToDecimal(100); // 2.0, break-even at 50%
  assert.ok(expectedValue(5, decimal, 0.6) > 0);
  assert.ok(expectedValue(5, decimal, 0.4) < 0);
  assert.ok(Math.abs(expectedValue(5, decimal, 0.5)) < 1e-12);
});

test('break-even rate is what the price demands', () => {
  assert.ok(Math.abs(breakEvenRate(100) - 0.5) < 1e-12);
  assert.ok(Math.abs(breakEvenRate(-110) - 0.5238095) < 1e-6);
});
