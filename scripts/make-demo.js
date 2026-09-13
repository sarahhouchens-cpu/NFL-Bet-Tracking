#!/usr/bin/env node
/**
 * Generates the offline fixture: a week of NFL events shaped exactly like The
 * Odds API returns them, plus the matching DraftKings salary export.
 *
 * This exists so the site, the tests and a first-time clone all work without an
 * API key and without spending credits. The numbers are invented but the
 * *shapes* are not — prices carry a realistic hold, lines sit where a book
 * would post them, and the payload nests bookmakers inside markets inside
 * outcomes the way the real one does. A fixture that is easier to parse than
 * the real feed would hide exactly the bugs it is supposed to catch.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

/** Deterministic pseudo-random so the fixture is stable across runs. */
let seed = 20260913;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const between = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (list) => list[Math.floor(rnd() * list.length)];

const TEAMS = {
  KC: 'Kansas City Chiefs', BUF: 'Buffalo Bills', PHI: 'Philadelphia Eagles',
  DAL: 'Dallas Cowboys', SF: 'San Francisco 49ers', SEA: 'Seattle Seahawks',
  CIN: 'Cincinnati Bengals', BAL: 'Baltimore Ravens', DET: 'Detroit Lions',
  GB: 'Green Bay Packers', MIA: 'Miami Dolphins', NYJ: 'New York Jets',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', LAR: 'Los Angeles Rams',
  ATL: 'Atlanta Falcons',
};

const FIRST = ['Jalen','Marcus','Tyler','Devon','Amari','Chris','Isaiah','Brandon','Trey','Xavier','Cam','Jordan','Malik','Darius','Elijah','Nico','Rome','Bijan','Jaxon','Garrett'];
const LAST = ['Carter','Mitchell','Hayes','Brooks','Reeves','Dawson','Coleman','Bryant','Sutton','Pierce','Ellis','Grant','Foster','Nash','Bowers','Vance','Rhodes','Keene','Lang','Wells'];

const usedNames = new Set();
function playerName() {
  for (let i = 0; i < 200; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  return `Player ${usedNames.size + 1}`;
}

const BOOKS = [
  { key: 'draftkings', title: 'DraftKings' },
  { key: 'fanduel', title: 'FanDuel' },
  { key: 'betmgm', title: 'BetMGM' },
];

/**
 * Price a true probability the way a book would: add a margin and round to a
 * plausible American number. Each book gets a slightly different opinion, which
 * is what makes line shopping — and therefore the "best price wins" logic —
 * testable.
 */
function priceFor(trueProbability, holdPerSide = 0.024) {
  const p = Math.min(0.95, Math.max(0.05, trueProbability + between(-0.02, 0.02)));
  const withHold = Math.min(0.97, p + holdPerSide);
  const decimal = 1 / withHold;
  const american = decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
  // Books post prices in fives.
  return Math.round(american / 5) * 5;
}

function overUnder(marketKey, players, lineFor, probabilityFor) {
  return (book) => ({
    key: marketKey,
    last_update: new Date().toISOString(),
    outcomes: players.flatMap((player) => {
      const line = lineFor(player);
      const probability = probabilityFor(player);
      return [
        { name: 'Over', description: player.name, price: priceFor(probability), point: line },
        { name: 'Under', description: player.name, price: priceFor(1 - probability), point: line },
      ];
    }),
  });
}

/** A pass catcher whose catches and yards agree at a plausible rate. */
function receiver(name, position, team, recYards, yardsPerReception) {
  const rate = yardsPerReception * between(0.88, 1.14);
  return { name, position, team, recYards, receptions: Math.max(0.8, recYards / rate) };
}

/** A back whose rushing yards and receiving work both hang off his usage. */
function back(name, team, rushYards, recYards) {
  const rate = 7.5 * between(0.85, 1.18);
  return { name, position: 'RB', team, rushYards, recYards, receptions: Math.max(0.6, recYards / rate) };
}

function buildGame(id, awayAbbr, homeAbbr, commenceTime) {
  const total = Math.round(between(38, 52) * 2) / 2;
  const homeSpread = Math.round(between(-9.5, 3.5) * 2) / 2;

  const roster = (abbr) => {
    const teamTotal = abbr === homeAbbr ? (total - homeSpread) / 2 : (total + homeSpread) / 2;
    const passLean = between(0.52, 0.68);
    return {
      abbr,
      teamTotal,
      qb: { name: playerName(), position: 'QB', team: abbr, passYards: teamTotal * 11 * passLean, rushYards: between(5, 32) },
      rbs: [
        back(playerName(), abbr, teamTotal * 3.1 * (1 - passLean) + between(10, 30), between(18, 42)),
        back(playerName(), abbr, teamTotal * 1.2 * (1 - passLean), between(6, 18)),
      ],
      // Catches are derived from yardage at a realistic yards-per-reception,
      // with a little noise. Drawing the two independently would make the
      // fixture internally inconsistent in exactly the way the reconciliation
      // model looks for, and every demo board would show a fake edge.
      wrs: [
        receiver(playerName(), 'WR', abbr, teamTotal * 3.2 * passLean, 13.5),
        receiver(playerName(), 'WR', abbr, teamTotal * 2.1 * passLean, 12.0),
        receiver(playerName(), 'WR', abbr, teamTotal * 1.3 * passLean, 10.5),
      ],
      te: receiver(playerName(), 'TE', abbr, teamTotal * 1.6 * passLean, 10.5),
    };
  };

  const away = roster(awayAbbr);
  const home = roster(homeAbbr);
  const sides = [away, home];

  // Passing yards are the same yards as receiving yards, so the fixture derives
  // the quarterback's line from his receivers' rather than drawing it
  // separately. Drawing both would leave a standing disagreement in the data
  // that the reconciliation model would faithfully report as an edge on every
  // quarterback in the league.
  for (const side of sides) {
    const charted = [...side.wrs, side.te, ...side.rbs].reduce((sum, p) => sum + (p.recYards ?? 0), 0);
    side.qb.passYards = charted / 0.95;
  }

  const passers = sides.map((s) => s.qb);
  const rushers = sides.flatMap((s) => [s.qb, ...s.rbs]);
  const receivers = sides.flatMap((s) => [...s.wrs, s.te, ...s.rbs]);
  const scorers = sides.flatMap((s) => [...s.rbs, ...s.wrs, s.te]);

  // A half-point line placed near the projection, which is where a book puts it.
  const halfLine = (value) => Math.round(value - 0.5) + 0.5;

  const bookmakers = BOOKS.map((book) => ({
    key: book.key,
    title: book.title,
    last_update: new Date().toISOString(),
    markets: [
      {
        key: 'totals',
        outcomes: [
          { name: 'Over', price: -110, point: total },
          { name: 'Under', price: -110, point: total },
        ],
      },
      {
        key: 'spreads',
        outcomes: [
          { name: TEAMS[homeAbbr], price: -110, point: homeSpread },
          { name: TEAMS[awayAbbr], price: -110, point: -homeSpread },
        ],
      },
      overUnder('player_pass_yds', passers, (p) => halfLine(p.passYards), () => between(0.47, 0.53))(book),
      overUnder('player_pass_tds', passers, () => 1.5, (p) => Math.min(0.72, p.passYards / 380))(book),
      overUnder('player_rush_yds', rushers, (p) => halfLine(p.rushYards), () => between(0.46, 0.54))(book),
      overUnder('player_reception_yds', receivers, (p) => halfLine(p.recYards ?? 8), () => between(0.46, 0.54))(book),
      overUnder('player_receptions', receivers, (p) => halfLine(p.receptions ?? 1.5), () => between(0.46, 0.54))(book),
      {
        key: 'player_anytime_td',
        last_update: new Date().toISOString(),
        outcomes: scorers.map((player) => {
          const share = player.position === 'RB' ? 0.3 : player.position === 'TE' ? 0.16 : 0.2;
          const side = sides.find((s) => s.abbr === player.team);
          const probability = Math.min(0.62, (side.teamTotal / 7) * share);
          return { name: 'Yes', description: player.name, price: priceFor(probability, 0.05) };
        }),
      },
    ],
  }));

  const players = [
    ...sides.flatMap((s) => [s.qb, ...s.rbs, ...s.wrs, s.te]),
  ];

  return {
    event: {
      id,
      sport_key: 'americanfootball_nfl',
      commence_time: commenceTime,
      home_team: TEAMS[homeAbbr],
      away_team: TEAMS[awayAbbr],
      bookmakers,
    },
    players,
    homeAbbr,
    awayAbbr,
    commenceTime,
  };
}

const SCHEDULE = [
  ['g1', 'BUF', 'KC', '2026-09-20T17:00:00Z'],
  ['g2', 'DAL', 'PHI', '2026-09-20T17:00:00Z'],
  ['g3', 'SEA', 'SF', '2026-09-20T17:00:00Z'],
  ['g4', 'CIN', 'BAL', '2026-09-20T17:00:00Z'],
  ['g5', 'GB', 'DET', '2026-09-20T17:00:00Z'],
  ['g6', 'NYJ', 'MIA', '2026-09-20T17:00:00Z'],
  ['g7', 'IND', 'HOU', '2026-09-20T20:25:00Z'],
  ['g8', 'ATL', 'LAR', '2026-09-20T20:25:00Z'],
  ['g9', 'DET', 'GB', '2026-09-21T00:20:00Z'],
  ['g10', 'KC', 'BUF', '2026-09-22T00:15:00Z'],
];

const built = SCHEDULE.slice(0, 8).map(([id, away, home, time]) => buildGame(id, away, home, time));
// The Sunday and Monday night games reuse two matchups so the fixture produces
// showdown slates as well as a main slate.
built.push(buildGame('g9', 'SEA', 'ATL', '2026-09-21T00:20:00Z'));
built.push(buildGame('g10', 'HOU', 'IND', '2026-09-22T00:15:00Z'));

const events = built.map((g) => g.event);

/** The salary export DraftKings would publish for the same slate. */
const salaryRows = [['Position', 'Name + ID', 'Name', 'ID', 'Roster Position', 'Salary', 'Game Info', 'TeamAbbrev', 'AvgPointsPerGame']];
let playerId = 10000;
for (const game of built) {
  const info = `${game.awayAbbr}@${game.homeAbbr} ${game.commenceTime}`;
  for (const player of game.players) {
    const projected =
      (player.passYards ?? 0) * 0.04 +
      (player.rushYards ?? 0) * 0.1 +
      (player.recYards ?? 0) * 0.1 +
      (player.receptions ?? 0) +
      2.5;
    const salary = Math.round(Math.min(9500, Math.max(3000, 2600 + projected * 260)) / 100) * 100;
    playerId++;
    salaryRows.push([player.position, `${player.name} (${playerId})`, player.name, String(playerId), player.position, String(salary), info, player.team, projected.toFixed(1)]);
  }
  for (const abbr of [game.homeAbbr, game.awayAbbr]) {
    playerId++;
    salaryRows.push(['DST', `${TEAMS[abbr]} (${playerId})`, TEAMS[abbr], String(playerId), 'DST', String(Math.round(between(2200, 3900) / 100) * 100), info, abbr, '7.0']);
  }
}

const csv = salaryRows
  .map((row) => row.map((cell) => (/[",]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : cell)).join(','))
  .join('\n');

await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, 'demo-events.json'), JSON.stringify(events, null, 1));
await writeFile(join(DATA, 'demo-salaries.csv'), csv);

console.log(`Wrote ${events.length} demo events and ${salaryRows.length - 1} salary rows.`);
