import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalCdf, normalQuantile, impliedMean, impliedSd, percentile,
  probabilityOver, expectedTouchdowns,
} from '../lib/distribution.js';

test('the normal CDF hits its known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
});

test('the quantile function inverts the CDF', () => {
  for (const p of [0.05, 0.2, 0.5, 0.85, 0.95]) {
    assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-4, `round trip at ${p}`);
  }
  assert.throws(() => normalQuantile(0));
  assert.throws(() => normalQuantile(1));
});

test('a line priced at a coin flip implies the line itself', () => {
  assert.ok(Math.abs(impliedMean(62.5, 0.5, 'recYards') - 62.5) < 1e-6);
});

test('the implied mean re-prices back to the probability it came from', () => {
  // This round trip is the whole basis of the projection model — if it does not
  // hold, every edge the board reports is an artefact of the inversion.
  for (const [line, probability, stat] of [
    [62.5, 0.6, 'recYards'],
    [245.5, 0.45, 'passYards'],
    [4.5, 0.55, 'receptions'],
    [78.5, 0.52, 'rushYards'],
  ]) {
    const mean = impliedMean(line, probability, stat);
    assert.ok(
      Math.abs(probabilityOver(line, mean, stat) - probability) < 1e-3,
      `${stat} at ${line} / ${probability}`
    );
  }
});

test('a line the market likes implies a mean above it', () => {
  assert.ok(impliedMean(62.5, 0.65, 'recYards') > 62.5);
  assert.ok(impliedMean(62.5, 0.35, 'recYards') < 62.5);
});

test('a projection is never negative', () => {
  assert.ok(impliedMean(0.5, 0.01, 'receptions') >= 0);
});

test('noisier stats get wider bands', () => {
  // Receiving yards swing much harder than completions do, and the tournament
  // lineups live entirely off that difference.
  assert.ok(impliedSd(60, 'recYards') > impliedSd(60, 'completions'));
});

test('percentiles straddle the mean', () => {
  const mean = 60;
  assert.ok(percentile(mean, 'recYards', 0.2) < mean);
  assert.ok(percentile(mean, 'recYards', 0.85) > mean);
  assert.ok(percentile(mean, 'recYards', 0.01) >= 0, 'floored at zero');
});

test('anytime touchdown price implies more than its own probability', () => {
  // A 60% chance to score is worth more than 0.6 touchdowns, because some of
  // those games are two-touchdown games.
  const expected = expectedTouchdowns(0.6);
  assert.ok(expected > 0.6);
  assert.ok(Math.abs(expected - 0.9163) < 1e-3);
  // 1 - e^-L should return the price.
  assert.ok(Math.abs(1 - Math.exp(-expected) - 0.6) < 1e-9);
});
