/**
 * Parsing for The Odds API's NFL payloads.
 *
 * Kept separate from the fetching so the mapping rules — which decide what a
 * bet actually is — can be tested exhaustively against fixtures. Getting these
 * wrong does not throw; it silently prices the wrong bet, which is the worst
 * failure this repo can have.
 */

/**
 * The player markets we model.
 *
 * `stat` is the projection key the line feeds, which is how one feed drives
 * both the value board and the DraftKings projections. `kind` decides how the
 * outcomes are read:
 *
 *   over_under — outcome.name is Over/Under, outcome.point is the line.
 *   yes_no     — outcome.name is Yes/No (or the player's own name on older
 *                payloads) and there is no line at all.
 *
 * Anything absent from this table is dropped rather than guessed at.
 */
export const PLAYER_MARKETS = {
  player_pass_yds:        { kind: 'over_under', stat: 'passYards',    label: 'passing yards',       position: 'QB' },
  player_pass_tds:        { kind: 'over_under', stat: 'passTds',      label: 'passing TDs',         position: 'QB' },
  player_pass_attempts:   { kind: 'over_under', stat: 'passAttempts', label: 'pass attempts',       position: 'QB' },
  player_pass_completions:{ kind: 'over_under', stat: 'completions',  label: 'completions',         position: 'QB' },
  player_pass_interceptions:{ kind: 'over_under', stat: 'interceptions', label: 'interceptions',    position: 'QB' },
  player_rush_yds:        { kind: 'over_under', stat: 'rushYards',    label: 'rushing yards',       position: null },
  player_rush_attempts:   { kind: 'over_under', stat: 'carries',      label: 'carries',             position: null },
  player_reception_yds:   { kind: 'over_under', stat: 'recYards',     label: 'receiving yards',     position: null },
  player_receptions:      { kind: 'over_under', stat: 'receptions',   label: 'receptions',          position: null },
  player_anytime_td:      { kind: 'yes_no',     stat: 'anytimeTd',    label: 'to score a TD',       position: null },
  player_1st_td:          { kind: 'yes_no',     stat: 'firstTd',      label: 'to score first',      position: null },
  player_kicking_points:  { kind: 'over_under', stat: 'kickingPoints',label: 'kicking points',      position: 'K' },
};

/** Game-level markets, used for implied team totals and game environment. */
export const GAME_MARKETS = { h2h: 'moneyline', spreads: 'spread', totals: 'total' };

/**
 * Markets that must never reach a ticket.
 *
 * First-touchdown and longest-completion style props are high-variance lottery
 * markets whose prices carry the fattest margins on the board. They are fine to
 * project from but have no place in a bet the model claims an edge on.
 */
export const BANNED_FROM_TICKETS = new Set(['player_1st_td', 'player_last_td']);

/**
 * Normalize a player name for matching across feeds.
 *
 * Books, DraftKings and stats providers disagree about punctuation and
 * suffixes — "Marvin Harrison Jr.", "Marvin Harrison", "A.J. Brown", "AJ
 * Brown" — and a failed match silently drops a player rather than erroring.
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** American odds are non-zero numbers; anything else is a malformed quote. */
const validPrice = (price) => Number.isFinite(Number(price)) && Number(price) !== 0;

/**
 * Pull the player's name out of an outcome, whichever shape the book used.
 *
 * Over/under props put the player in `description` and the side in `name`.
 * Yes/no props do the same on current payloads, but older ones put the player
 * in `name` with no description at all. Reading the wrong field turns every
 * anytime-touchdown leg into a player called "Yes".
 */
export function outcomePlayer(outcome) {
  const name = String(outcome?.name ?? '').trim();
  const description = String(outcome?.description ?? '').trim();
  if (description) return description;
  if (/^(over|under|yes|no)$/i.test(name)) return null;
  return name || null;
}

/** Which side of the market an outcome is. */
export function outcomeSide(outcome) {
  const name = String(outcome?.name ?? '').trim();
  if (/^over$/i.test(name)) return 'over';
  if (/^under$/i.test(name)) return 'under';
  if (/^yes$/i.test(name)) return 'yes';
  if (/^no$/i.test(name)) return 'no';
  // A bare player name on a yes/no market is the "yes" side.
  if (name && String(outcome?.description ?? '').trim() === '') return 'yes';
  return null;
}

/**
 * Flatten one event's player props into a quote per player, market and line.
 *
 * Two things happen here that matter to the bettor:
 *
 * 1. Best price wins. The same prop is priced differently at each book, and
 *    taking the best available number is line shopping — the one edge available
 *    to a retail bettor that requires no opinion at all.
 * 2. Both sides are paired from the *same* book. Devigging mixes the two sides
 *    of one market, so pairing an over at DraftKings with an under at FanDuel
 *    would produce a fair probability neither book ever offered.
 *
 * The line is part of the key: "over 40.5 receiving yards" and "over 55.5" are
 * different bets, and collapsing them would let the model price one and bet the
 * other.
 */
export function parsePlayerProps(event) {
  const quotes = new Map();

  for (const book of event?.bookmakers ?? []) {
    for (const market of book?.markets ?? []) {
      const spec = PLAYER_MARKETS[market?.key];
      if (!spec) continue;

      // Group this book's outcomes so the two sides of each line pair up.
      const sides = new Map();
      for (const outcome of market?.outcomes ?? []) {
        const player = outcomePlayer(outcome);
        const side = outcomeSide(outcome);
        if (!player || !side || !validPrice(outcome?.price)) continue;

        const point = spec.kind === 'over_under' ? Number(outcome?.point) : null;
        if (spec.kind === 'over_under' && !Number.isFinite(point)) continue;

        const id = `${normalizeName(player)}|${market.key}|${point ?? 'y'}`;
        const entry = sides.get(id) ?? {
          playerName: player,
          marketKey: market.key,
          stat: spec.stat,
          line: point,
          yes: null,
          no: null,
        };
        if (side === 'over' || side === 'yes') entry.yes = Number(outcome.price);
        else entry.no = Number(outcome.price);
        sides.set(id, entry);
      }

      for (const [id, entry] of sides) {
        if (entry.yes == null) continue;
        const existing = quotes.get(id);
        // Higher American odds always pay more, on either side of zero.
        if (!existing || entry.yes > existing.americanOdds) {
          quotes.set(id, {
            ...entry,
            americanOdds: entry.yes,
            oppositeAmericanOdds: entry.no,
            book: book.title ?? book.key,
            gameId: event?.id ?? null,
          });
        }
      }
    }
  }
  return quotes;
}

/**
 * Consensus spread and total for an event, plus the implied team totals.
 *
 * Team total is the identity every football model starts from: a team favoured
 * by 7 in a game totalling 45 is implied to score 26, and 26 points is about
 * three touchdowns of scoring to distribute. The median across books is used
 * rather than the best price, because here the aim is the market's opinion, not
 * the most generous quote.
 */
export function parseGameLines(event) {
  const totals = [];
  const spreads = new Map();

  for (const book of event?.bookmakers ?? []) {
    for (const market of book?.markets ?? []) {
      if (market.key === 'totals') {
        const point = Number(market.outcomes?.[0]?.point);
        if (Number.isFinite(point)) totals.push(point);
      }
      if (market.key === 'spreads') {
        for (const outcome of market.outcomes ?? []) {
          const point = Number(outcome?.point);
          if (!outcome?.name || !Number.isFinite(point)) continue;
          if (!spreads.has(outcome.name)) spreads.set(outcome.name, []);
          spreads.get(outcome.name).push(point);
        }
      }
    }
  }

  const home = event?.home_team ?? null;
  const away = event?.away_team ?? null;
  const total = median(totals);
  const homeSpread = median(spreads.get(home) ?? []);

  // total = home + away, and spread is home's margin with the sign a book uses
  // (negative when favoured), so home = (total - spread) / 2.
  const teamTotals =
    Number.isFinite(total) && Number.isFinite(homeSpread)
      ? { [home]: (total - homeSpread) / 2, [away]: (total + homeSpread) / 2 }
      : {};

  return {
    gameId: event?.id ?? null,
    home,
    away,
    commenceTime: event?.commence_time ?? null,
    total: Number.isFinite(total) ? total : null,
    homeSpread: Number.isFinite(homeSpread) ? homeSpread : null,
    teamTotals,
  };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Every distinct player carrying a prop, for driving the board off the feed. */
export function playersInFeed(quotes) {
  const names = new Map();
  for (const quote of quotes.values()) {
    names.set(normalizeName(quote.playerName), quote.playerName);
  }
  return names;
}
