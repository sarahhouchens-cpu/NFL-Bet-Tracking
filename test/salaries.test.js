import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseDkSalaries, estimateSalary, attachSalaries, normalizePosition } from '../lib/salaries.js';

test('quoted fields containing commas do not shear the row', () => {
  // The DraftKings export quotes Game Info, which contains commas. Splitting on
  // commas would move every later column left — silently, and after the salary.
  const rows = parseCsv('a,b,"c,d",e\n1,2,"3,4",5');
  assert.deepEqual(rows[0], ['a', 'b', 'c,d', 'e']);
  assert.deepEqual(rows[1], ['1', '2', '3,4', '5']);
});

test('escaped quotes inside a field survive', () => {
  assert.deepEqual(parseCsv('a,"say ""hi""",c')[0], ['a', 'say "hi"', 'c']);
});

test('a DraftKings export parses into players', () => {
  const csv = [
    'Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame',
    'QB,"Josh Allen (1)",Josh Allen,1,QB,7800,"BUF@KC 09/21/2026 01:00PM ET",BUF,22.4',
    'DST,"Ravens (2)",Ravens,2,DST,3400,"CIN@BAL 09/21/2026 01:00PM ET",BAL,8.2',
  ].join('\n');

  const rows = parseDkSalaries(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].salary, 7800);
  assert.equal(rows[0].team, 'BUF');
  assert.equal(rows[0].playerId, 'josh allen');
  assert.equal(rows[1].position, 'DST');
});

test('defence position spellings all normalize', () => {
  assert.equal(normalizePosition('DEF'), 'DST');
  assert.equal(normalizePosition('D/ST'), 'DST');
  assert.equal(normalizePosition('dst'), 'DST');
  assert.equal(normalizePosition('WR'), 'WR');
});

test('a showdown export keeps the flex salary, not the captain one', () => {
  // Showdown lists each player twice; the captain row costs 1.5x, and the
  // optimiser applies that multiplier itself.
  const csv = [
    'Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame',
    'QB,"Josh Allen (1)",Josh Allen,1,CPT,15600,"BUF@KC",BUF,22.4',
    'QB,"Josh Allen (1)",Josh Allen,1,FLEX,10400,"BUF@KC",BUF,22.4',
  ].join('\n');

  const attached = attachSalaries(
    [{ playerId: 'josh allen', playerName: 'Josh Allen', position: 'QB', points: 20 }],
    parseDkSalaries(csv)
  );
  assert.equal(attached[0].salary, 10400);
});

test('without an export, salaries are estimated and flagged as such', () => {
  const attached = attachSalaries([{ playerId: 'x', playerName: 'X', position: 'WR', points: 12 }], []);
  assert.equal(attached[0].salarySource, 'estimated');
  assert.ok(attached[0].salary >= 3000);
  assert.equal(attached[0].salary % 100, 0, 'DraftKings prices in hundreds');
});

test('estimated salaries rise with projection and stay inside real bounds', () => {
  assert.ok(estimateSalary('WR', 19) > estimateSalary('WR', 6));
  assert.ok(estimateSalary('RB', 100) <= 10000, 'clamped at the top');
  assert.ok(estimateSalary('DST', 0) >= 2000, 'clamped at the bottom');
});

test('a player missing from the export is dropped, not invented', () => {
  // If an export exists, a player absent from it is not on that slate, and
  // pricing them anyway puts an unrosterable player in a lineup.
  const rows = parseDkSalaries(
    'Position,Name,Salary,TeamAbbrev\nQB,Josh Allen,7800,BUF'.replace('Name,', 'Name,').replace(/\n/, '\n')
  );
  const attached = attachSalaries(
    [
      { playerId: 'josh allen', playerName: 'Josh Allen', position: 'QB', points: 20 },
      { playerId: 'nobody', playerName: 'Nobody', position: 'WR', points: 10 },
    ],
    rows
  );
  assert.equal(attached.length, 1);
  assert.equal(attached[0].playerName, 'Josh Allen');
});

test("the export's team abbreviation wins over the odds feed's full name", () => {
  // Defences arrive from the odds feed holding a full team name while skill
  // players hold an abbreviation. A same-team comparison across those two
  // spellings is always false, which would make every defence look like it was
  // facing its own offence.
  const csv = [
    'Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame',
    'DST,"Kansas City Chiefs (1)",Kansas City Chiefs,1,DST,3400,"BUF@KC",KC,7.0',
  ].join('\n');

  const attached = attachSalaries(
    [{ playerId: 'kansas city chiefs', playerName: 'Kansas City Chiefs', position: 'DST', points: 7, team: 'Kansas City Chiefs' }],
    parseDkSalaries(csv)
  );
  assert.equal(attached[0].team, 'KC');
});
