/**
 * What each daily fantasy site actually pays for, and what it lets you roster.
 *
 * DraftKings and FanDuel look similar and are not the same game. The
 * differences below are small to read and large to optimise against:
 *
 *   - DraftKings pays a full point per reception; FanDuel pays half. That one
 *     number reorders the entire player pool. A back catching six passes is
 *     worth three more points on DraftKings than on FanDuel, which is most of
 *     the gap between a mid-tier back and an expensive one.
 *   - DraftKings pays three-point bonuses at 100 rushing, 100 receiving and 300
 *     passing yards. FanDuel pays none. Bonuses are what make high-total games
 *     and boom players disproportionately valuable, so removing them flattens
 *     the pool and makes FanDuel lineups look more like a projection ranking.
 *   - The caps differ ($50,000 against $60,000) and so do the single-game
 *     rosters: six players with a captain who costs 1.5x, against five with an
 *     MVP who does not cost a premium at all.
 *
 * A lineup optimised under the wrong table is optimised for a contest nobody is
 * running, and nothing about it will look wrong on the page. These constants
 * are therefore worth checking against each site's own rules page before you
 * trust a lineup with money — they are written here, in one place, for exactly
 * that reason.
 */

/** Classic roster shape both sites happen to share: nine spots, one flex. */
const CLASSIC_SLOTS = [
  { slot: 'QB', eligible: ['QB'] },
  { slot: 'RB1', eligible: ['RB'] },
  { slot: 'RB2', eligible: ['RB'] },
  { slot: 'WR1', eligible: ['WR'] },
  { slot: 'WR2', eligible: ['WR'] },
  { slot: 'WR3', eligible: ['WR'] },
  { slot: 'TE', eligible: ['TE'] },
  { slot: 'FLEX', eligible: ['RB', 'WR', 'TE'] },
  { slot: 'DST', eligible: ['DST'] },
];

const ANY = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

export const DRAFTKINGS = {
  id: 'draftkings',
  name: 'DraftKings',
  salaryCap: 50000,
  /** DraftKings prices in hundreds. */
  salaryStep: 100,

  scoring: {
    passYard: 0.04,
    passTd: 4,
    interception: -1,
    rushYard: 0.1,
    rushTd: 6,
    reception: 1,
    recYard: 0.1,
    recTd: 6,
    fumbleLost: -1,
    twoPointConversion: 2,
    returnTd: 6,
    // Threshold bonuses, each paid once when the stat is reached.
    bonuses: [
      { stat: 'passYards', at: 300, points: 3, key: 'pass300' },
      { stat: 'rushYards', at: 100, points: 3, key: 'rush100' },
      { stat: 'recYards', at: 100, points: 3, key: 'rec100' },
    ],
  },

  dst: { sack: 1, interception: 2, fumbleRecovery: 2, safety: 2, blockedKick: 2, touchdown: 6 },

  classic: { roster: CLASSIC_SLOTS, minGames: 3 },
  showdown: {
    name: 'Showdown',
    captainLabel: 'CPT',
    // The captain scores 1.5x and is charged 1.5x salary.
    captainCostsMultiplier: true,
    roster: [
      { slot: 'CPT', eligible: ANY, multiplier: 1.5 },
      { slot: 'FLEX1', eligible: ANY },
      { slot: 'FLEX2', eligible: ANY },
      { slot: 'FLEX3', eligible: ANY },
      { slot: 'FLEX4', eligible: ANY },
      { slot: 'FLEX5', eligible: ANY },
    ],
  },
};

export const FANDUEL = {
  id: 'fanduel',
  name: 'FanDuel',
  salaryCap: 60000,
  /** FanDuel prices in hundreds too, but off a larger cap. */
  salaryStep: 100,

  scoring: {
    passYard: 0.04,
    passTd: 4,
    interception: -1,
    rushYard: 0.1,
    rushTd: 6,
    // Half point per reception — the single biggest difference between the two.
    reception: 0.5,
    recYard: 0.1,
    recTd: 6,
    // FanDuel charges twice as much for a lost fumble.
    fumbleLost: -2,
    twoPointConversion: 2,
    returnTd: 6,
    // No threshold bonuses at all.
    bonuses: [],
  },

  dst: { sack: 1, interception: 2, fumbleRecovery: 2, safety: 2, blockedKick: 2, touchdown: 6 },

  classic: { roster: CLASSIC_SLOTS, minGames: 3 },
  showdown: {
    name: 'Single Game',
    captainLabel: 'MVP',
    // FanDuel's MVP scores 1.5x but is charged the ordinary salary, so the
    // decision of who to captain is purely about points rather than a trade
    // against the cap. Applying DraftKings' premium here would rule out the
    // best MVP on most slates.
    captainCostsMultiplier: false,
    roster: [
      { slot: 'MVP', eligible: ANY, multiplier: 1.5 },
      { slot: 'FLEX1', eligible: ANY },
      { slot: 'FLEX2', eligible: ANY },
      { slot: 'FLEX3', eligible: ANY },
      { slot: 'FLEX4', eligible: ANY },
    ],
  },
};

export const SITES = { draftkings: DRAFTKINGS, fanduel: FANDUEL };
export const SITE_IDS = Object.keys(SITES);
export const DEFAULT_SITE = DRAFTKINGS;

export function siteById(id) {
  return SITES[String(id ?? '').toLowerCase()] ?? DEFAULT_SITE;
}

/** The roster a site uses for a given slate format. */
export function rosterFor(site, format) {
  return format === 'showdown' ? site.showdown.roster : site.classic.roster;
}

/**
 * What a player costs in a slot.
 *
 * The captain multiplier is a DraftKings rule, not a universal one, so it is
 * read off the site rather than off the slot. Charging FanDuel's MVP a premium
 * it does not have would quietly price the best captain out of every lineup.
 */
export function slotSalary(player, slot, site = DEFAULT_SITE) {
  const multiplier = slot?.multiplier ?? 1;
  // Only a captain slot carries a multiplier, so no classic slot reaches the
  // branch below. Reading the rule off the site rather than the slot is what
  // keeps FanDuel's MVP at its ordinary price.
  if (multiplier === 1) return player.salary;
  return site.showdown.captainCostsMultiplier ? player.salary * multiplier : player.salary;
}
