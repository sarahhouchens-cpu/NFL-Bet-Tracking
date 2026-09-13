/**
 * The normal distribution, and the inversion that turns a betting line back
 * into a projection.
 *
 * This is the hinge of the whole repo. A sportsbook that posts "Over 62.5
 * receiving yards -115 / Under -105" has told you, after the margin is removed,
 * exactly what it thinks the chance of clearing 62.5 is. Invert that and you
 * have the market's own projection — which is a far better starting point than
 * any season-average model a spreadsheet could produce, because it already
 * contains the injury report, the weather and the game plan.
 */

/** Standard normal CDF, via the Abramowitz & Stegun 7.1.26 erf approximation. */
export function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Standard normal quantile (the inverse CDF), via Acklam's rational
 * approximation. Accurate to about 1e-9, which is far tighter than the odds
 * feeding it.
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`Quantile needs 0 < p < 1, got ${p}`);

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Coefficient of variation by stat — how noisy each one is, as a fraction of
 * its own mean.
 *
 * These set the spread of the distribution fitted to each line. They matter
 * because they decide the ceiling: receiving yards for a deep threat swing far
 * harder week to week than a quarterback's completions, and a tournament lineup
 * lives entirely off that difference. Values are the conventional ranges from
 * NFL box-score distributions — wide for big-play stats, tight for volume ones.
 */
export const STAT_VARIATION = {
  passYards: 0.28,
  passAttempts: 0.18,
  completions: 0.20,
  passTds: 0.65,
  interceptions: 0.90,
  rushYards: 0.50,
  carries: 0.30,
  recYards: 0.62,
  receptions: 0.38,
  kickingPoints: 0.45,
};

/** Fallback for a stat with no measured spread. */
export const DEFAULT_VARIATION = 0.45;

/**
 * Recover the market's implied mean for a stat from one posted line.
 *
 * If the stat is roughly normal with mean m and spread s, then
 *   P(over L) = 1 - CDF((L - m) / s)
 * so
 *   m = L + s * Q(P(over))
 *
 * The spread itself scales with the mean, which is circular, so this solves the
 * two together by iterating from the line as a first guess. It converges in a
 * handful of passes because the dependence is mild.
 */
export function impliedMean(line, probabilityOver, stat) {
  const cv = STAT_VARIATION[stat] ?? DEFAULT_VARIATION;
  const p = Math.min(0.995, Math.max(0.005, probabilityOver));
  const z = normalQuantile(p);

  let mean = Math.max(line, 0.5);
  for (let i = 0; i < 25; i++) {
    const sd = Math.max(cv * mean, 0.5);
    const next = line + sd * z;
    if (Math.abs(next - mean) < 1e-6) {
      mean = next;
      break;
    }
    // Damped update: an undamped one oscillates when the line sits far from the
    // mean, which happens on alternate lines a book posts deep in a tail.
    mean = mean + 0.6 * (next - mean);
  }

  // A negative mean is not a projection of anything; the market can imply one
  // when a line sits in a tail with a badly-priced other side.
  return Math.max(0, mean);
}

/** Standard deviation implied for a stat at a given mean. */
export function impliedSd(mean, stat) {
  const cv = STAT_VARIATION[stat] ?? DEFAULT_VARIATION;
  return Math.max(cv * mean, 0.5);
}

/**
 * A percentile of the fitted distribution, floored at zero.
 * Used for the floor and ceiling that separate a cash lineup from a tournament
 * one.
 */
export function percentile(mean, stat, q) {
  return Math.max(0, mean + impliedSd(mean, stat) * normalQuantile(q));
}

/**
 * Probability of clearing a threshold, given a fitted mean.
 * The inverse of impliedMean, used to re-price a line the model disagrees with.
 */
export function probabilityOver(line, mean, stat) {
  return 1 - normalCdf((line - mean) / impliedSd(mean, stat));
}

/**
 * Expected touchdowns behind an anytime-touchdown price.
 *
 * "Anytime" is P(at least one). Treating scores as Poisson, P(>=1) = 1 - e^-L,
 * so L = -ln(1 - P). The difference matters for fantasy scoring: a back priced
 * at 60% to score is worth more than 0.6 touchdowns, because some of those
 * games are two-touchdown games.
 */
export function expectedTouchdowns(anytimeProbability) {
  const p = Math.min(0.95, Math.max(0.001, anytimeProbability));
  return -Math.log(1 - p);
}
