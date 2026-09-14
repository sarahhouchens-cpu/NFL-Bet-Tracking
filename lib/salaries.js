/**
 * Where DraftKings salaries come from.
 *
 * DraftKings publishes no salary API. The exact numbers live in the CSV you can
 * export from any contest lobby, and with that file in hand every lineup this
 * repo builds is one you can actually enter.
 *
 * Without it the site would have nothing to optimise against, so there is a
 * fallback that derives a salary from the market's own projection. That is a
 * real approximation of how DraftKings prices a slate — salary tracks expected
 * points closely, by position — but it is an approximation, and a lineup built
 * on it can be a few hundred dollars off the cap. The site labels which of the
 * two it used rather than letting an estimated lineup pass for an exact one.
 */

import { normalizeName } from './markets.js';

/**
 * Parse the DKSalaries.csv DraftKings exports.
 *
 * The export carries a "Roster Position" column that distinguishes CPT from
 * FLEX on showdown slates, which is why a showdown player appears twice at two
 * different salaries. Reading `Position` instead would silently price every
 * captain at their flex salary.
 */
export function parseDkSalaries(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  const index = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const nameAt = index('Name');
  const positionAt = index('Position');
  const rosterAt = index('Roster Position');
  const salaryAt = index('Salary');
  const teamAt = index('TeamAbbrev');
  const gameAt = index('Game Info');
  const avgAt = index('AvgPointsPerGame');

  if (nameAt < 0 || salaryAt < 0) return [];

  const out = [];
  for (const row of rows.slice(1)) {
    if (row.length <= salaryAt) continue;
    const playerName = row[nameAt]?.trim();
    const salary = Number(String(row[salaryAt]).replace(/[^0-9.]/g, ''));
    if (!playerName || !Number.isFinite(salary) || salary <= 0) continue;

    const rosterPosition = rosterAt >= 0 ? row[rosterAt]?.trim() : '';
    const position = positionAt >= 0 ? row[positionAt]?.trim() : '';

    out.push({
      playerName,
      playerId: normalizeName(playerName),
      position: normalizePosition(position),
      rosterPosition: rosterPosition || normalizePosition(position),
      salary,
      team: teamAt >= 0 ? row[teamAt]?.trim() : null,
      gameInfo: gameAt >= 0 ? row[gameAt]?.trim() : null,
      averagePoints: avgAt >= 0 ? Number(row[avgAt]) || 0 : 0,
      source: 'draftkings',
    });
  }
  return out;
}

/** DraftKings writes defences as DST; everything else already matches. */
export function normalizePosition(position) {
  const p = String(position ?? '').trim().toUpperCase();
  if (p === 'DEF' || p === 'D/ST' || p === 'DST' || p === 'D') return 'DST';
  return p;
}

/**
 * A minimal CSV reader that respects quoted fields.
 *
 * The DraftKings export quotes the Game Info column, which contains commas
 * ("BUF@KC 09/21/2026 01:00PM ET"). Splitting on commas would shear every row
 * after that column into the wrong fields — and because the salary sits before
 * it, the damage would be silent rather than obvious.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }

  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);

  return rows;
}

/**
 * Parse the player list FanDuel exports.
 *
 * The shape is different enough from DraftKings' that it needs its own reader
 * rather than a few extra header aliases:
 *
 *   - The name is split across "First Name" and "Last Name", with "Nickname"
 *     carrying what the player is actually called. Reading only Last Name would
 *     match half the league to the wrong person.
 *   - Defences are position "D" rather than "DST".
 *   - The matchup is a "Game" column like "DEN@KC" plus separate "Team" and
 *     "Opponent" columns, so team attribution is direct.
 *   - There is an "Injury Indicator" column, and a player marked out is still
 *     listed at a salary. Rostering one is a wasted spot, so they are dropped.
 */
export function parseFanDuelSalaries(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  const index = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const firstAt = index('First Name');
  const lastAt = index('Last Name');
  const nickAt = index('Nickname');
  const positionAt = index('Position');
  const salaryAt = index('Salary');
  const teamAt = index('Team');
  const opponentAt = index('Opponent');
  const gameAt = index('Game');
  const fppgAt = index('FPPG');
  const injuryAt = index('Injury Indicator');
  const rosterAt = index('Roster Position');

  if (salaryAt < 0 || (firstAt < 0 && nickAt < 0)) return [];

  const out = [];
  for (const row of rows.slice(1)) {
    if (row.length <= salaryAt) continue;

    const first = firstAt >= 0 ? (row[firstAt] ?? '').trim() : '';
    const last = lastAt >= 0 ? (row[lastAt] ?? '').trim() : '';
    const nickname = nickAt >= 0 ? (row[nickAt] ?? '').trim() : '';
    const playerName = nickname || [first, last].filter(Boolean).join(' ');

    const salary = Number(String(row[salaryAt]).replace(/[^0-9.]/g, ''));
    if (!playerName || !Number.isFinite(salary) || salary <= 0) continue;

    // O is out, IR is injured reserve. Neither can be rostered usefully.
    const injury = injuryAt >= 0 ? (row[injuryAt] ?? '').trim().toUpperCase() : '';
    if (injury === 'O' || injury === 'IR' || injury === 'D') continue;

    out.push({
      playerName,
      playerId: normalizeName(playerName),
      position: normalizePosition(positionAt >= 0 ? row[positionAt] : ''),
      rosterPosition: rosterAt >= 0 ? (row[rosterAt] ?? '').trim() : '',
      salary,
      team: teamAt >= 0 ? (row[teamAt] ?? '').trim() : null,
      opponent: opponentAt >= 0 ? (row[opponentAt] ?? '').trim() : null,
      gameInfo: gameAt >= 0 ? (row[gameAt] ?? '').trim() : null,
      averagePoints: fppgAt >= 0 ? Number(row[fppgAt]) || 0 : 0,
      source: 'fanduel',
    });
  }
  return out;
}

/**
 * Work out which site an export came from and read it accordingly.
 *
 * Detection is by header rather than by filename, because the file people
 * actually download is called something like `FanDuel-NFL-2026-09-14-players.csv`
 * on one site and `DKSalaries.csv` on the other, and either can be renamed.
 * "First Name" is the giveaway: DraftKings never splits the name.
 */
export function parseSalaries(csv) {
  const firstLine = String(csv ?? '').split(/\r?\n/, 1)[0].toLowerCase();
  if (firstLine.includes('first name') || firstLine.includes('nickname')) {
    return parseFanDuelSalaries(csv);
  }
  return parseDkSalaries(csv);
}

/** Which site's players are in a parsed set, if they agree. */
export function siteOfSalaries(rows) {
  const sources = new Set(rows.map((r) => r.source));
  return sources.size === 1 ? [...sources][0] : null;
}

/**
 * Salary structure DraftKings prices to, by position.
 *
 * `base` is roughly what the cheapest rostered player at the position costs and
 * `perPoint` is what each additional projected point adds. These come from the
 * shape of a typical main slate: a quarterback projected for 20 points sits
 * near $7,000, a receiver projected for 12 near $6,000, and the minimum-priced
 * body at any position sits around $3,000.
 */
export const SALARY_MODELS = {
  draftkings: {
    QB: { base: 4000, perPoint: 140, min: 4000, max: 9000 },
    RB: { base: 3000, perPoint: 250, min: 3000, max: 10000 },
    WR: { base: 3000, perPoint: 250, min: 3000, max: 10000 },
    TE: { base: 2500, perPoint: 220, min: 2500, max: 8000 },
    DST: { base: 2000, perPoint: 150, min: 2000, max: 4500 },
    K: { base: 3500, perPoint: 120, min: 3500, max: 5500 },
  },
  // FanDuel prices off a larger cap and scores fewer points per player, so both
  // the floor and the price of a point are higher. Reusing DraftKings' curve
  // would leave every FanDuel lineup thousands under the cap.
  fanduel: {
    QB: { base: 4500, perPoint: 195, min: 5000, max: 10000 },
    RB: { base: 4000, perPoint: 250, min: 4500, max: 10500 },
    WR: { base: 4000, perPoint: 230, min: 4500, max: 10500 },
    TE: { base: 4200, perPoint: 180, min: 4500, max: 9000 },
    DST: { base: 3300, perPoint: 100, min: 3000, max: 5500 },
    K: { base: 4200, perPoint: 90, min: 4000, max: 6000 },
  },
};

/** Kept for callers that predate FanDuel support. */
export const SALARY_MODEL = SALARY_MODELS.draftkings;

/**
 * Estimate a salary from a projection, for when no export is available.
 *
 * Rounded to the nearest hundred because both sites price that way, and a
 * lineup summing to $49,987 would give away that the numbers are not real ones.
 */
export function estimateSalary(position, points, siteId = 'draftkings') {
  const models = SALARY_MODELS[siteId] ?? SALARY_MODELS.draftkings;
  const model = models[position] ?? models.WR;
  const raw = model.base + Math.max(0, points) * model.perPoint;
  const clamped = Math.min(model.max, Math.max(model.min, raw));
  return Math.round(clamped / 100) * 100;
}

/**
 * Attach salaries to projected players, preferring the real export.
 *
 * Matching is by normalized name, which is the only key the two sources share.
 * A projection with no salary row is dropped rather than estimated: on a slate
 * where the export exists, a player missing from it is not on the slate, and
 * inventing a price would put an unrosterable player in a lineup.
 */
export function attachSalaries(players, salaryRows = [], siteId = 'draftkings') {
  if (!salaryRows.length) {
    return players.map((player) => ({
      ...player,
      salary: estimateSalary(player.position, player.points, siteId),
      salarySource: 'estimated',
    }));
  }

  const byId = new Map();
  for (const row of salaryRows) {
    // Showdown exports list each player twice; the FLEX row carries the base
    // salary, which is the one the optimiser multiplies for a captain.
    const existing = byId.get(row.playerId);
    if (!existing || row.salary < existing.salary) byId.set(row.playerId, row);
  }

  const out = [];
  for (const player of players) {
    const row = byId.get(player.playerId);
    if (!row) continue;
    out.push({
      ...player,
      salary: row.salary,
      salarySource: 'draftkings',
      // The export's abbreviation wins over whatever the player already
      // carried. Defences are built from the odds feed and hold a full team
      // name ("San Francisco 49ers") while skill players hold an abbreviation
      // ("SF"), and a same-team comparison across those two spellings is always
      // false — which would quietly make every defence look like it was facing
      // its own offence, and cost the correlation model the one relationship it
      // is most confident about.
      team: row.team || player.team,
      // The export knows positions for certain; the inference only guessed.
      position: row.position || player.position,
    });
  }
  return out;
}
