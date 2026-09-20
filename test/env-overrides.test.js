import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * These guard a failure that produced two weeks of empty boards while every
 * run reported success.
 *
 * A GitHub Actions `env:` entry fed from an unset repository variable arrives
 * as an empty string, not as undefined. `??` does not fire on an empty string,
 * so `process.env.ODDS_MARKETS ?? defaults` took the empty override, split it
 * into zero markets, and fetched `markets=` — which costs a credit, returns an
 * event with no props, and looks exactly like a slate whose props are not
 * posted yet.
 */

/** The same helpers update.js uses, exercised without importing its fetch path. */
function envList(value, fallback) {
  const raw = String(value ?? '').trim();
  const parsed = raw ? raw.split(',').map((v) => v.trim()).filter(Boolean) : [];
  return parsed.length ? parsed : fallback;
}

function envNumber(value, fallback) {
  const raw = String(value ?? '').trim();
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) ? parsed : fallback;
}

const MARKETS = ['a', 'b', 'c'];

test('an unset override falls back to the defaults', () => {
  assert.deepEqual(envList(undefined, MARKETS), MARKETS);
  assert.deepEqual(envList(null, MARKETS), MARKETS);
});

test('an EMPTY override falls back too, rather than winning with nothing', () => {
  // This is the exact bug: Actions passes '' for an unset repository variable.
  assert.deepEqual(envList('', MARKETS), MARKETS);
  assert.deepEqual(envList('   ', MARKETS), MARKETS);
  assert.deepEqual(envList(',,,', MARKETS), MARKETS);
});

test('a real override is honoured and trimmed', () => {
  assert.deepEqual(envList('x,y', MARKETS), ['x', 'y']);
  assert.deepEqual(envList(' x , y ', MARKETS), ['x', 'y']);
  assert.deepEqual(envList('x,,y,', MARKETS), ['x', 'y']);
});

test('numeric overrides survive the same trap', () => {
  // Number('') is 0, so an empty reserve would silently become "spend it all".
  assert.equal(envNumber('', 150), 150);
  assert.equal(envNumber('   ', 150), 150);
  assert.equal(envNumber(undefined, 150), 150);
  assert.equal(envNumber('not a number', 150), 150);
  assert.equal(envNumber('0', 150), 0, 'an explicit zero is a real choice');
  assert.equal(envNumber('200', 150), 200);
});

test('update.js ships a non-empty market list', async () => {
  // Belt and braces: whatever the environment does, the module must never
  // export an empty list, because a run with no markets buys nothing.
  delete process.env.ODDS_MARKETS;
  const { PROP_MARKETS } = await import('../scripts/update.js');
  assert.ok(Array.isArray(PROP_MARKETS) && PROP_MARKETS.length > 0);
  assert.ok(PROP_MARKETS.includes('player_reception_yds'));
});
