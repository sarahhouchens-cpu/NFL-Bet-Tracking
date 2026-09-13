/**
 * The bet log: storage, grading and the running totals.
 *
 * Kept separate from rendering so the arithmetic — which is the part that can
 * be quietly wrong for weeks — can be reasoned about and tested on its own.
 *
 * Bets live in localStorage. That is a real limitation and the page says so:
 * they survive a refresh but not a new device or a cleared cache, which is why
 * export exists.
 */

import { americanToDecimal, isValidAmerican, breakEvenRate, formatAmerican } from '../lib/odds.js';

const KEY = 'nfl-bet-tracking:bets:v1';

/** A bet that has not been graded yet contributes to nothing but exposure. */
export const OPEN = 'open';

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isBet) : [];
  } catch {
    // A corrupt store should cost the session, not every future one.
    return [];
  }
}

export function save(bets) {
  try {
    localStorage.setItem(KEY, JSON.stringify(bets));
    return true;
  } catch {
    return false;
  }
}

function isBet(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && isValidAmerican(value.odds);
}

/**
 * Validate and normalize what the form collected.
 *
 * Returns either a bet or a message explaining what is wrong with it, because
 * the two failures worth catching — a price of 0 and a price between -100 and
 * 100 — both look like ordinary numbers and would otherwise sail through into
 * payout arithmetic that silently produces nonsense.
 */
export function parseBet(input) {
  const description = String(input.description ?? '').trim();
  if (!description) return { error: 'Give the bet a description.' };

  const odds = Number(String(input.odds ?? '').replace(/[^0-9+-]/g, ''));
  if (!isValidAmerican(odds)) return { error: 'Odds must be an American price, like -110 or +240.' };
  if (odds > -100 && odds < 100) {
    return { error: `${odds} is not a valid American price — they run from +100 up and -100 down.` };
  }

  const stake = Number(String(input.stake ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(stake) || stake <= 0) return { error: 'Stake has to be a positive number.' };

  const date = String(input.date ?? '').trim() || today();

  return {
    bet: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description,
      date,
      type: String(input.type ?? 'other'),
      odds,
      stake,
      book: String(input.book ?? '').trim(),
      result: OPEN,
      loggedAt: new Date().toISOString(),
    },
  };
}

export function today() {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Profit or loss on a graded bet.
 *
 * A push returns the stake, so it is zero rather than a loss — counting pushes
 * as losses is the most common way a tracked record ends up worse than the real
 * one, and counting them as wins is the most common way it ends up better.
 */
export function profitOf(bet) {
  if (bet.result === 'won') return bet.stake * americanToDecimal(bet.odds) - bet.stake;
  if (bet.result === 'lost') return -bet.stake;
  return 0;
}

/**
 * The running totals.
 *
 * Return on investment is measured against *settled* stake, not against every
 * dollar ever staked. Including open bets in the denominator makes the number
 * drift every time a bet is logged and before anything has happened, which
 * reads as performance changing when nothing has.
 */
export function summarize(bets) {
  const settled = bets.filter((b) => b.result === 'won' || b.result === 'lost');
  const graded = bets.filter((b) => b.result !== OPEN);
  const open = bets.filter((b) => b.result === OPEN);

  const won = settled.filter((b) => b.result === 'won').length;
  const lost = settled.filter((b) => b.result === 'lost').length;
  const pushed = graded.length - settled.length;

  const staked = settled.reduce((sum, b) => sum + b.stake, 0);
  const profit = settled.reduce((sum, b) => sum + profitOf(b), 0);

  // What the prices taken actually required, weighted by stake. A 50% record is
  // good at +150 and terrible at -200, and a bare win rate cannot tell you which
  // one you had.
  const requiredStake = settled.reduce((sum, b) => sum + b.stake, 0);
  const breakEven = requiredStake
    ? settled.reduce((sum, b) => sum + breakEvenRate(b.odds) * b.stake, 0) / requiredStake
    : null;

  return {
    total: bets.length,
    open: open.length,
    openStake: open.reduce((sum, b) => sum + b.stake, 0),
    won,
    lost,
    pushed,
    settled: settled.length,
    staked,
    profit,
    roi: staked ? profit / staked : null,
    winRate: settled.length ? won / settled.length : null,
    breakEven,
  };
}

/** Cumulative profit after each settled bet, oldest first. */
export function bankrollCurve(bets) {
  const settled = bets
    .filter((b) => b.result === 'won' || b.result === 'lost')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.loggedAt).localeCompare(String(b.loggedAt)));

  let running = 0;
  return settled.map((bet) => {
    running += profitOf(bet);
    return { date: bet.date, profit: running };
  });
}

/** What a bet returns in total if it wins — the number on the slip. */
export function payoutOf(bet) {
  return bet.stake * americanToDecimal(bet.odds);
}

export { formatAmerican };
