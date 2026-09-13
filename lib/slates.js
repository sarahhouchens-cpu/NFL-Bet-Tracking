/**
 * Groups a week's games into the slates DraftKings actually posts.
 *
 * A lineup only means something inside a slate. "Best lineup of the week" is
 * not a thing you can enter — you enter a lineup for the Sunday main slate, or
 * for the Monday night showdown, and the same player can be a great play in one
 * and unusable in the other because the pool around him is different.
 *
 * Kick-off times decide everything here, and they are compared in US Eastern
 * because that is the clock the NFL schedule is written on.
 */

const ET = 'America/New_York';

/** Day and hour of a kick-off, on the Eastern clock. */
export function easternParts(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Minutes past midnight Eastern, for ordering kick-offs within a day. */
function minutesOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

/**
 * The slate definitions, in the order they should be offered.
 *
 * `format` is what it sounds like: classic slates take a nine-man roster,
 * showdown slates are a single game with a captain. A slate only appears if the
 * week's schedule actually produces it — there is no Thursday slate in Week 18,
 * and the site should not invent one.
 */
export const SLATE_RULES = [
  {
    id: 'thursday',
    name: 'Thursday Night',
    format: 'showdown',
    matches: (p) => p.weekday === 'Thu',
  },
  {
    id: 'sunday-early',
    name: 'Sunday Early',
    format: 'classic',
    matches: (p) => p.weekday === 'Sun' && minutesOfDay(p) >= 11 * 60 && minutesOfDay(p) < 15 * 60,
  },
  {
    id: 'sunday-afternoon',
    name: 'Sunday Afternoon',
    format: 'classic',
    matches: (p) => p.weekday === 'Sun' && minutesOfDay(p) >= 15 * 60 && minutesOfDay(p) < 18 * 60,
  },
  {
    id: 'sunday-night',
    name: 'Sunday Night',
    format: 'showdown',
    matches: (p) => p.weekday === 'Sun' && minutesOfDay(p) >= 18 * 60,
  },
  {
    id: 'monday',
    name: 'Monday Night',
    format: 'showdown',
    matches: (p) => p.weekday === 'Mon',
  },
  {
    id: 'saturday',
    name: 'Saturday',
    format: 'classic',
    matches: (p) => p.weekday === 'Sat',
  },
];

/**
 * The main slate is the one most contests are built around: every Sunday game
 * kicking off before the late-afternoon window closes, in one pool. It overlaps
 * the early and afternoon slates deliberately — DraftKings posts all three and
 * a player can enter any of them.
 */
const MAIN_SLATE = {
  id: 'sunday-main',
  name: 'Sunday Main',
  format: 'classic',
  matches: (p) => p.weekday === 'Sun' && minutesOfDay(p) >= 11 * 60 && minutesOfDay(p) < 18 * 60,
};

/** Fewest games a classic slate needs before a nine-man roster makes sense. */
export const MIN_CLASSIC_GAMES = 3;

/**
 * Sort a week's games into slates.
 *
 * Showdown slates are per-game: a Sunday with two late games produces two
 * separate showdown slates, not one with both in it, because that is how the
 * contests are posted.
 */
export function buildSlates(games) {
  const dated = games
    .map((game) => ({ game, parts: easternParts(game.commenceTime) }))
    .filter((entry) => entry.parts);

  const slates = [];

  for (const rule of [MAIN_SLATE, ...SLATE_RULES]) {
    const matched = dated.filter((entry) => rule.matches(entry.parts));
    if (!matched.length) continue;

    if (rule.format === 'showdown') {
      for (const entry of matched) {
        slates.push({
          id: `${rule.id}-${entry.game.gameId}`,
          name: `${rule.name}: ${shortName(entry.game.away)} at ${shortName(entry.game.home)}`,
          format: 'showdown',
          games: [entry.game],
          startsAt: entry.game.commenceTime,
        });
      }
      continue;
    }

    if (matched.length < MIN_CLASSIC_GAMES) continue;

    slates.push({
      id: rule.id,
      name: rule.name,
      format: 'classic',
      games: matched.map((entry) => entry.game),
      startsAt: matched
        .map((entry) => entry.game.commenceTime)
        .sort()[0],
    });
  }

  // A slate whose game list exactly matches another's is a duplicate — the main
  // slate swallows the early one on a week where every game is at one o'clock.
  const seen = new Map();
  const unique = [];
  for (const slate of slates) {
    const key = `${slate.format}|${slate.games.map((g) => g.gameId).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.set(key, slate);
    unique.push(slate);
  }

  return unique.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
}

/** Last word of a team name, which is how a slate label reads naturally. */
export function shortName(team) {
  const parts = String(team ?? '').trim().split(/\s+/);
  return parts[parts.length - 1] || String(team ?? '');
}
