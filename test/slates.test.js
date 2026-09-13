import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlates, easternParts, shortName, MIN_CLASSIC_GAMES } from '../lib/slates.js';

const game = (gameId, away, home, commenceTime) => ({ gameId, away, home, commenceTime });

// A normal week: five one o'clock games, two late ones, Sunday night, Monday.
const WEEK = [
  game('1', 'Bills', 'Chiefs', '2026-09-20T17:00:00Z'),
  game('2', 'Jets', 'Patriots', '2026-09-20T17:00:00Z'),
  game('3', 'Bears', 'Lions', '2026-09-20T17:00:00Z'),
  game('4', 'Browns', 'Ravens', '2026-09-20T17:00:00Z'),
  game('5', 'Texans', 'Colts', '2026-09-20T17:00:00Z'),
  game('6', 'Rams', '49ers', '2026-09-20T20:25:00Z'),
  game('7', 'Falcons', 'Seahawks', '2026-09-20T20:25:00Z'),
  game('8', 'Cowboys', 'Giants', '2026-09-21T00:20:00Z'),
  game('9', 'Raiders', 'Broncos', '2026-09-22T00:15:00Z'),
];

test('kick-offs are read on the Eastern clock', () => {
  // 17:00 UTC is one o'clock Sunday afternoon in New York.
  const parts = easternParts('2026-09-20T17:00:00Z');
  assert.equal(parts.weekday, 'Sun');
  assert.equal(parts.hour, 13);
});

test('a normal week produces the slates DraftKings posts', () => {
  const slates = buildSlates(WEEK);
  const ids = slates.map((s) => s.id);

  assert.ok(ids.includes('sunday-main'), 'no main slate');
  assert.ok(ids.includes('sunday-early'), 'no early slate');
  assert.ok(ids.some((id) => id.startsWith('sunday-night')), 'no Sunday night showdown');
  assert.ok(ids.some((id) => id.startsWith('monday')), 'no Monday night showdown');

  const main = slates.find((s) => s.id === 'sunday-main');
  assert.equal(main.format, 'classic');
  assert.equal(main.games.length, 7, 'main slate is every game before the night window');

  const night = slates.find((s) => s.id.startsWith('sunday-night'));
  assert.equal(night.format, 'showdown');
  assert.equal(night.games.length, 1);
});

test('each night game becomes its own showdown, not a shared one', () => {
  const slates = buildSlates([
    game('1', 'A', 'B', '2026-09-21T00:20:00Z'),
    game('2', 'C', 'D', '2026-09-21T00:20:00Z'),
  ]);
  const showdowns = slates.filter((s) => s.format === 'showdown');
  assert.equal(showdowns.length, 2);
  assert.ok(showdowns.every((s) => s.games.length === 1));
});

test('a classic slate is not invented from too few games', () => {
  const slates = buildSlates([
    game('1', 'A', 'B', '2026-09-20T17:00:00Z'),
    game('2', 'C', 'D', '2026-09-20T17:00:00Z'),
  ]);
  assert.equal(MIN_CLASSIC_GAMES, 3);
  assert.equal(slates.filter((s) => s.format === 'classic').length, 0);
});

test('identical slates are not listed twice', () => {
  // A week where every game is at one o'clock makes the main and early slates
  // the same set of games.
  const slates = buildSlates([
    game('1', 'A', 'B', '2026-09-20T17:00:00Z'),
    game('2', 'C', 'D', '2026-09-20T17:00:00Z'),
    game('3', 'E', 'F', '2026-09-20T17:00:00Z'),
  ]);
  const classic = slates.filter((s) => s.format === 'classic');
  assert.equal(classic.length, 1);
});

test('slates are ordered by kick-off', () => {
  const times = buildSlates(WEEK).map((s) => s.startsAt);
  assert.deepEqual(times, [...times].sort());
});

test('a bad timestamp is dropped rather than crashing the week', () => {
  const slates = buildSlates([...WEEK, game('x', 'A', 'B', 'not a date')]);
  assert.ok(slates.length > 0);
});

test('slate labels read naturally', () => {
  assert.equal(shortName('Kansas City Chiefs'), 'Chiefs');
  assert.equal(shortName('49ers'), '49ers');
});
