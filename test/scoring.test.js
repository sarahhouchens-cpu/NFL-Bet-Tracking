import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePlayer, scoreDst, projectedPoints, value, SALARY_CAP, CLASSIC_ROSTER, SHOWDOWN_ROSTER } from '../lib/scoring.js';

test('a passing line scores the way DraftKings scores it', () => {
  // 300 yards = 12, two touchdowns = 8, an interception = -1, 300-yard bonus = 3.
  assert.equal(scorePlayer({ passYards: 300, passTds: 2, interceptions: 1 }), 22);
});

test('the 300-yard passing bonus lands exactly on the threshold', () => {
  assert.equal(scorePlayer({ passYards: 299 }), 11.96);
  assert.equal(scorePlayer({ passYards: 300 }), 15);
});

test('a rushing line scores with its own bonus', () => {
  // 100 yards = 10, a touchdown = 6, 100-yard bonus = 3.
  assert.equal(scorePlayer({ rushYards: 100, rushTds: 1 }), 19);
  assert.equal(scorePlayer({ rushYards: 99, rushTds: 1 }), 15.9);
});

test('receptions are full point-per-reception', () => {
  // 8 catches = 8, 100 yards = 10, a touchdown = 6, 100-yard bonus = 3.
  assert.equal(scorePlayer({ receptions: 8, recYards: 100, recTds: 1 }), 27);
});

test('rushing and receiving bonuses stack on the same player', () => {
  const both = scorePlayer({ rushYards: 100, recYards: 100, receptions: 5 });
  // 10 + 10 + 5 receptions + two 3-point bonuses.
  assert.equal(both, 31);
});

test('defence scoring runs through the points-allowed tiers', () => {
  assert.equal(scoreDst({ pointsAllowed: 0 }), 10);
  assert.equal(scoreDst({ pointsAllowed: 6 }), 7);
  assert.equal(scoreDst({ pointsAllowed: 7 }), 4);
  assert.equal(scoreDst({ pointsAllowed: 13 }), 4);
  assert.equal(scoreDst({ pointsAllowed: 14 }), 1);
  assert.equal(scoreDst({ pointsAllowed: 21 }), 0);
  assert.equal(scoreDst({ pointsAllowed: 28 }), -1);
  assert.equal(scoreDst({ pointsAllowed: 35 }), -4);
  assert.equal(scoreDst({ sacks: 3, interceptions: 1, pointsAllowed: 10 }), 9);
});

test('a projection does not collect a bonus it has only half earned', () => {
  // Scoring the mean would hand a 100-yard projection the full three points.
  // The expected value of a threshold is its probability times its size.
  const asBoxScore = scorePlayer({ recYards: 100, receptions: 6 });
  const asProjection = projectedPoints({ recYards: 100, receptions: 6 }, { rec100: 0.5 });
  assert.equal(asBoxScore, 19);
  assert.equal(asProjection, 17.5);
  assert.ok(asProjection < asBoxScore);
});

test('missing stats are treated as zero rather than NaN', () => {
  assert.equal(scorePlayer({}), 0);
  assert.equal(scorePlayer({ passYards: undefined, rushYards: null }), 0);
  assert.equal(projectedPoints({}, {}), 0);
});

test('value is points per thousand dollars', () => {
  assert.equal(value(20, 5000), 4);
  assert.equal(value(20, 0), 0);
});

test('roster shapes match the contest', () => {
  assert.equal(SALARY_CAP, 50000);
  assert.equal(CLASSIC_ROSTER.length, 9);
  assert.equal(CLASSIC_ROSTER.filter((s) => s.eligible.length > 1).length, 1, 'exactly one FLEX');
  assert.equal(SHOWDOWN_ROSTER.length, 6);
  assert.equal(SHOWDOWN_ROSTER[0].multiplier, 1.5);
});
