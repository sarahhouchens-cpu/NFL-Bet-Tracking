#!/usr/bin/env node
/**
 * Reports what an Odds API key actually unlocks for the NFL.
 *
 * Run this before trusting the market list in update.js. Prop availability
 * varies by plan and by how close kick-off is, and a market that is simply not
 * in your tier fails quietly — the event comes back with no outcomes for it,
 * the board loses those legs, and nothing anywhere says why. Finding that out
 * here costs a handful of credits; finding it out on Sunday morning costs the
 * board.
 *
 * Manual only, and it prices exactly one event so the check itself stays cheap.
 */

const ODDS_KEY = process.env.ODDS_API_KEY ?? '';
const ODDS_BASE = process.env.ODDS_API_BASE ?? 'https://api.the-odds-api.com/v4';
const SPORT = 'americanfootball_nfl';

const CANDIDATE_MARKETS = [
  'player_pass_yds',
  'player_pass_tds',
  'player_pass_attempts',
  'player_pass_completions',
  'player_pass_interceptions',
  'player_rush_yds',
  'player_rush_attempts',
  'player_reception_yds',
  'player_receptions',
  'player_anytime_td',
  'player_1st_td',
  'player_kicking_points',
];

const quota = (res) => {
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  return remaining ? `  [${used} used, ${remaining} left]` : '';
};

async function main() {
  if (!ODDS_KEY) {
    console.error('ODDS_API_KEY is not set. Add it as the TheOdds_API_Key secret.');
    process.exitCode = 1;
    return;
  }

  console.log('Checking the key against The Odds API.\n');

  const sports = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
  console.log(`  /sports                        ${sports.status} ${sports.statusText}${quota(sports)}`);
  if (!sports.ok) {
    console.log('\n  A failure here means the key itself is not valid. Nothing else will work.');
    process.exitCode = 1;
    return;
  }

  const eventsRes = await fetch(`${ODDS_BASE}/sports/${SPORT}/events?apiKey=${ODDS_KEY}`);
  console.log(`  /sports/${SPORT}/events   ${eventsRes.status} ${eventsRes.statusText}${quota(eventsRes)}`);
  if (!eventsRes.ok) {
    console.log('\n  The key is valid but has no NFL access.');
    process.exitCode = 1;
    return;
  }

  const events = await eventsRes.json();
  const upcoming = events.filter((e) => new Date(e.commence_time).getTime() > Date.now());
  console.log(`\n  ${events.length} events listed, ${upcoming.length} still upcoming.`);

  if (!upcoming.length) {
    console.log('  No upcoming game to price — try again during the season.');
    return;
  }

  const target = upcoming[0];
  console.log(`  Probing markets against ${target.away_team} at ${target.home_team}.\n`);

  // One market at a time, so a single unsupported market cannot make the whole
  // request fail and hide the ones that do work.
  for (const market of CANDIDATE_MARKETS) {
    const res = await fetch(
      `${ODDS_BASE}/sports/${SPORT}/events/${target.id}/odds` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=${market}&oddsFormat=american`
    );

    if (!res.ok) {
      console.log(`  ${market.padEnd(28)} ${res.status} ${res.statusText}`);
      continue;
    }

    const payload = await res.json();
    const books = payload?.bookmakers ?? [];
    const outcomes = books.reduce(
      (sum, book) => sum + (book.markets ?? []).reduce((n, m) => n + (m.outcomes?.length ?? 0), 0),
      0
    );
    const shape = books
      .flatMap((b) => b.markets ?? [])
      .flatMap((m) => m.outcomes ?? [])
      .slice(0, 1)
      .map((o) => `name="${o.name}" description="${o.description ?? ''}" point=${o.point ?? '—'}`)[0];

    console.log(
      `  ${market.padEnd(28)} ${String(res.status).padEnd(4)} ${String(books.length).padStart(2)} books, ` +
        `${String(outcomes).padStart(4)} outcomes${shape ? `  ${shape}` : ''}`
    );
  }

  console.log('\n  Reading the results:');
  console.log('   - 0 outcomes with a 200 means the market exists but is not posted yet.');
  console.log('   - 401 or 403 means the market is outside this key\'s plan.');
  console.log('   - 422 means the market key is not one the API recognises.');
  console.log('   - The printed shape tells you which field carries the player name,');
  console.log('     which is what lib/markets.js keys its parsing off.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
