#!/usr/bin/env node
/**
 * Fetches the week's NFL odds and rebuilds both boards.
 *
 * One script does both because the odds are the expensive part. The Odds API
 * charges a credit per market per region on every event it prices, so fetching
 * once and building the value board and the DraftKings pool from the same
 * snapshot costs half what two scripts would.
 *
 *   node scripts/update.js            # live, needs ODDS_API_KEY
 *   node scripts/update.js --demo     # offline fixture, no key, no credits
 *   node scripts/update.js --dry-run  # compute, write nothing
 */

import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBoard, buildDfs } from '../lib/board.js';
import { parseDkSalaries } from '../lib/salaries.js';
import { normalizeName } from '../lib/markets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SALARY_DIR = join(DATA, 'salaries');

const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const DRY_RUN = args.has('--dry-run');

const ODDS_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_BASE = process.env.ODDS_API_BASE ?? 'https://api.the-odds-api.com/v4';
const SPORT = 'americanfootball_nfl';

/**
 * Player prop markets to request, and what each one costs.
 *
 * Every market here is one credit per event. At sixteen games that makes this
 * list the entire budget: five markets is eighty credits a run, which on the
 * free tier's 500 a month allows a Thursday and a Sunday pass each week with
 * room to spare. Adding two more markets would halve the number of runs the
 * month can afford, so the list is deliberately short and covers the props that
 * carry the most volume.
 */
const PROP_MARKETS = [
  'player_pass_yds',
  'player_rush_yds',
  'player_reception_yds',
  'player_receptions',
  'player_anytime_td',
];

/** Game lines, fetched in bulk for every game at once for three credits total. */
const GAME_MARKETS = ['spreads', 'totals'];

/**
 * Stop fetching props if the key has less than this left.
 *
 * Running the quota to zero mid-week means no board at all on Sunday, which is
 * worse than a board built from game lines alone.
 */
const CREDIT_RESERVE = 40;

/** Only price games that have not kicked off and are close enough to matter. */
const LOOKAHEAD_DAYS = 8;

/**
 * How close to kick-off a game must be before its props are worth buying.
 *
 * This is the single biggest saving available. Game lines are posted a week
 * out, but player props are not — a book has nothing up for next Sunday's games
 * on a Monday afternoon. The old code priced every game inside the lookahead
 * window regardless, so a Monday run that needed one game's props paid for
 * sixteen and got fifteen empty responses back. At five markets a game that is
 * 75 wasted credits on a single run.
 *
 * Thirty hours covers a run the afternoon before a night game and a Sunday
 * morning run that reaches the late-afternoon slate, while excluding every game
 * that has not been priced yet.
 */
const PROP_WINDOW_HOURS = 30;

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} from ${url.split('?')[0]}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  return {
    data: await res.json(),
    remaining: Number(res.headers.get('x-requests-remaining')),
    used: Number(res.headers.get('x-requests-used')),
  };
}

/**
 * Fetch the week's events with their game lines, in one bulk call.
 *
 * The bulk odds endpoint charges per market per region regardless of how many
 * games come back, so this is two credits for the whole slate.
 */
async function fetchEvents() {
  const url =
    `${ODDS_BASE}/sports/${SPORT}/odds?apiKey=${ODDS_KEY}` +
    `&regions=us&markets=${GAME_MARKETS.join(',')}&oddsFormat=american`;
  const { data, remaining } = await getJSON(url);

  const cutoff = Date.now() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const upcoming = (data ?? []).filter((event) => {
    const start = new Date(event.commence_time).getTime();
    return Number.isFinite(start) && start > Date.now() && start < cutoff;
  });

  return { events: upcoming, remaining };
}

/**
 * Fetch player props for one event and merge them into the event payload.
 *
 * Props come from a different endpoint than the game lines, and merging the two
 * bookmaker lists here keeps everything downstream working from a single
 * event-shaped object.
 */
async function fetchProps(event) {
  const url =
    `${ODDS_BASE}/sports/${SPORT}/events/${event.id}/odds?apiKey=${ODDS_KEY}` +
    `&regions=us&markets=${PROP_MARKETS.join(',')}&oddsFormat=american`;

  const { data, remaining } = await getJSON(url);

  const byKey = new Map();
  for (const book of [...(event.bookmakers ?? []), ...(data?.bookmakers ?? [])]) {
    const existing = byKey.get(book.key);
    if (existing) existing.markets.push(...(book.markets ?? []));
    else byKey.set(book.key, { ...book, markets: [...(book.markets ?? [])] });
  }

  return { event: { ...event, bookmakers: [...byKey.values()] }, remaining };
}

/** Load every DraftKings salary export checked into data/salaries. */
async function loadSalaries() {
  try {
    const files = (await readdir(SALARY_DIR)).filter((f) => f.toLowerCase().endsWith('.csv'));
    const rows = [];
    for (const file of files) {
      rows.push(...parseDkSalaries(await readFile(join(SALARY_DIR, file), 'utf8')));
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Which team each player is on.
 *
 * The prop feed does not say, and without it the correlation model cannot tell
 * a quarterback stacked with his own receiver from two unrelated legs. The
 * DraftKings export does say, which is the main reason to keep one around even
 * when the salaries themselves are not needed.
 */
function teamMapFrom(salaryRows) {
  const map = new Map();
  for (const row of salaryRows) {
    if (row.team) map.set(row.playerId, row.team);
  }
  return map;
}

async function main() {
  let events = [];
  let remaining = NaN;

  if (DEMO) {
    events = JSON.parse(await readFile(join(DATA, 'demo-events.json'), 'utf8'));
    console.log(`Demo mode: ${events.length} events from the fixture.`);
  } else {
    if (!ODDS_KEY) throw new Error('ODDS_API_KEY is not set. Run with --demo to build from the fixture.');

    const fetched = await fetchEvents();
    events = fetched.events;
    remaining = fetched.remaining;
    console.log(`Fetched ${events.length} upcoming games. Credits remaining: ${remaining}.`);

    // Props are only bought for games close enough that a book has posted them.
    const windowEnd = Date.now() + PROP_WINDOW_HOURS * 60 * 60 * 1000;
    const worthPricing = events.filter((event) => new Date(event.commence_time).getTime() < windowEnd);
    const tooFarOut = events.length - worthPricing.length;
    if (tooFarOut) {
      console.log(
        `${tooFarOut} game(s) kick off more than ${PROP_WINDOW_HOURS}h out — their props are not posted yet, ` +
          `so they are skipped (saving ~${tooFarOut * PROP_MARKETS.length} credits).`
      );
    }

    const affordable = Number.isFinite(remaining)
      ? Math.max(0, Math.floor((remaining - CREDIT_RESERVE) / PROP_MARKETS.length))
      : worthPricing.length;

    if (affordable < worthPricing.length) {
      console.warn(`Only ${affordable} of ${worthPricing.length} games can be priced within the credit reserve.`);
    }

    const willPrice = worthPricing.slice(0, affordable);
    const pricedIds = new Set(willPrice.map((e) => e.id));
    const priced = [];
    for (const event of willPrice) {
      try {
        const result = await fetchProps(event);
        priced.push(result.event);
        remaining = result.remaining;
      } catch (error) {
        // One game failing should not cost the whole board.
        console.warn(`Props unavailable for ${event.away_team} at ${event.home_team}: ${error.message}`);
        priced.push(event);
      }
    }
    // Games that were not priced keep their game lines, which still drive the
    // implied team totals the defence projections are built from.
    events = [...priced, ...events.filter((e) => !pricedIds.has(e.id))];
    console.log(`Priced ${priced.length} game(s) for props. Credits remaining: ${remaining}.`);
  }

  const salaryRows = DEMO
    ? parseDkSalaries(await readFile(join(DATA, 'demo-salaries.csv'), 'utf8'))
    : await loadSalaries();

  if (salaryRows.length) console.log(`Loaded ${salaryRows.length} DraftKings salary rows.`);
  else console.log('No DraftKings salary export found — salaries will be estimated.');

  const board = buildBoard(events, { teamByPlayer: teamMapFrom(salaryRows), demo: DEMO });
  console.log(
    `Board: ${board.games.length} games, ${board.players.length} players, ` +
      `${board.legCount} candidate legs, ${board.tickets.length} tickets, ${board.stacks.length} stacks.`
  );

  const dfs = buildDfs(board, salaryRows, { demo: DEMO });
  console.log(`DraftKings: ${dfs.slates.length} slates (${dfs.salarySource} salaries).`);
  for (const slate of dfs.slates) {
    console.log(`  ${slate.slate.name}: ${slate.tournament.length} tournament, ${slate.doubleUp.length} double-up`);
  }

  if (DRY_RUN) {
    console.log('Dry run — nothing written.');
    return;
  }

  await mkdir(DATA, { recursive: true });
  // The player pool is large and only the DFS tab needs it, so it is not
  // written into the board file the value board tab loads.
  const { players, ...boardForSite } = board;
  await writeFile(join(DATA, 'board-latest.json'), JSON.stringify(boardForSite, null, 1));
  await writeFile(join(DATA, 'lineups-latest.json'), JSON.stringify(dfs, null, 1));
  await writeFile(
    join(DATA, 'pool-latest.json'),
    JSON.stringify({ generatedAt: board.generatedAt, players: board.players }, null, 1)
  );
  console.log('Wrote data/board-latest.json, data/lineups-latest.json, data/pool-latest.json.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
