import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlayerProps, parseGameLines, normalizeName, outcomePlayer, outcomeSide, median,
} from '../lib/markets.js';

const book = (key, title, markets) => ({ key, title, markets });

test('names normalize across the spellings different feeds use', () => {
  assert.equal(normalizeName('Marvin Harrison Jr.'), normalizeName('Marvin Harrison'));
  assert.equal(normalizeName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(normalizeName('Amon-Ra St. Brown'), 'amonra st brown');
  assert.equal(normalizeName(null), '');
});

test('the player is read from whichever field the book used', () => {
  // Over/under markets put the player in description.
  assert.equal(outcomePlayer({ name: 'Over', description: 'Josh Allen' }), 'Josh Allen');
  // Older yes/no payloads put the player in name with no description.
  assert.equal(outcomePlayer({ name: 'Josh Allen' }), 'Josh Allen');
  // And a bare side with no player is not a player.
  assert.equal(outcomePlayer({ name: 'Yes' }), null);
});

test('sides are identified on both market shapes', () => {
  assert.equal(outcomeSide({ name: 'Over', description: 'x' }), 'over');
  assert.equal(outcomeSide({ name: 'Under', description: 'x' }), 'under');
  assert.equal(outcomeSide({ name: 'Yes', description: 'x' }), 'yes');
  // A bare player name on a yes/no market is the yes side.
  assert.equal(outcomeSide({ name: 'Josh Allen' }), 'yes');
});

test('the best price across books wins', () => {
  const event = {
    id: 'g1',
    bookmakers: [
      book('dk', 'DraftKings', [{ key: 'player_receptions', outcomes: [
        { name: 'Over', description: 'A Player', price: -120, point: 4.5 },
        { name: 'Under', description: 'A Player', price: 100, point: 4.5 },
      ] }]),
      book('fd', 'FanDuel', [{ key: 'player_receptions', outcomes: [
        { name: 'Over', description: 'A Player', price: 105, point: 4.5 },
        { name: 'Under', description: 'A Player', price: -125, point: 4.5 },
      ] }]),
    ],
  };

  const quotes = [...parsePlayerProps(event).values()];
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].americanOdds, 105, 'takes the better over');
  assert.equal(quotes[0].book, 'FanDuel');
  // The under must come from the same book as the over, or devigging mixes two
  // books' opinions into a fair price neither of them offered.
  assert.equal(quotes[0].oppositeAmericanOdds, -125);
});

test('different lines on one market stay different bets', () => {
  const event = {
    id: 'g1',
    bookmakers: [
      book('dk', 'DraftKings', [{ key: 'player_reception_yds', outcomes: [
        { name: 'Over', description: 'A Player', price: -110, point: 40.5 },
        { name: 'Under', description: 'A Player', price: -110, point: 40.5 },
        { name: 'Over', description: 'A Player', price: 150, point: 60.5 },
        { name: 'Under', description: 'A Player', price: -180, point: 60.5 },
      ] }]),
    ],
  };

  const quotes = [...parsePlayerProps(event).values()];
  assert.equal(quotes.length, 2, 'an alternate line is a separate bet');
  assert.deepEqual(quotes.map((q) => q.line).sort((a, b) => a - b), [40.5, 60.5]);
});

test('unknown markets and malformed prices are dropped, not guessed at', () => {
  const event = {
    id: 'g1',
    bookmakers: [
      book('dk', 'DraftKings', [
        { key: 'player_shoe_size', outcomes: [{ name: 'Over', description: 'A Player', price: -110, point: 11.5 }] },
        { key: 'player_receptions', outcomes: [
          { name: 'Over', description: 'B Player', price: 0, point: 4.5 },
          { name: 'Over', description: 'C Player', price: -110 },
        ] },
      ]),
    ],
  };
  assert.equal(parsePlayerProps(event).size, 0);
});

test('a one-sided quote survives with no opposite price', () => {
  const event = {
    id: 'g1',
    bookmakers: [
      book('dk', 'DraftKings', [{ key: 'player_anytime_td', outcomes: [
        { name: 'Yes', description: 'A Player', price: 145 },
      ] }]),
    ],
  };
  const quotes = [...parsePlayerProps(event).values()];
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].americanOdds, 145);
  assert.equal(quotes[0].oppositeAmericanOdds, null);
});

test('implied team totals come out of the spread and the total', () => {
  const event = {
    id: 'g1',
    home_team: 'Kansas City Chiefs',
    away_team: 'Buffalo Bills',
    commence_time: '2026-09-20T17:00:00Z',
    bookmakers: [
      book('dk', 'DraftKings', [
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: 48.5 }] },
        { key: 'spreads', outcomes: [
          { name: 'Kansas City Chiefs', price: -110, point: -3.5 },
          { name: 'Buffalo Bills', price: -110, point: 3.5 },
        ] },
      ]),
    ],
  };

  const lines = parseGameLines(event);
  assert.equal(lines.total, 48.5);
  assert.equal(lines.homeSpread, -3.5);
  // A 3.5-point favourite in a 48.5-point game is implied to score 26.
  assert.equal(lines.teamTotals['Kansas City Chiefs'], 26);
  assert.equal(lines.teamTotals['Buffalo Bills'], 22.5);
  assert.equal(
    lines.teamTotals['Kansas City Chiefs'] + lines.teamTotals['Buffalo Bills'],
    48.5
  );
});

test('median takes the middle of the books, not the best of them', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});
