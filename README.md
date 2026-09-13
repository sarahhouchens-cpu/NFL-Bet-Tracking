# NFL Bet Tracking

Three things, on one page:

1. **Tracker** — log every bet, grade it, and see whether you are actually beating the prices you took.
2. **$5 → $100** — parlays built from live NFL prop markets that return at least $100 on a $5 stake.
3. **DraftKings** — lineup recommendations for every slate, built separately for tournaments and double-ups.

The site is static. A GitHub Action fetches odds a few times a week, rebuilds
both boards, and commits the JSON; the page just renders it. No API key ever
reaches the browser.

```
npm test              # 123 tests, no network
npm run board:demo    # build both boards from the offline fixture
npm run serve         # http://localhost:8080
```

Nothing here is betting advice. Every number is an estimate, most parlays are
bad bets, and the board will tell you so when they are.

---

## The tracker

Bets live in your browser's local storage. There is no account and nothing is
uploaded — which also means they do not follow you to another device, so there
is an export button.

Three things it does that a spreadsheet usually gets wrong:

- **A push is zero.** Not a loss, not a win. Counting pushes as losses is the
  commonest reason a tracked record looks worse than the real one.
- **Open bets are exposure, not performance.** They show as money at risk and
  stay out of the return calculation, so logging a bet does not move your
  numbers before anything has happened.
- **Break-even is shown next to your win rate.** A 50% record is excellent at
  +150 and dreadful at -200. The break-even figure is what your prices actually
  demanded, weighted by stake, so you can see which one you had.

## $5 → $100

$100 on a $5 stake is a decimal price of 20, about +1900. No single NFL prop
pays that without being a bet you should not want, so the board builds parlays
of three to six legs.

**The model reads the market rather than competing with it.** A sportsbook's
prop line is the sharpest public forecast of a player's week that exists — it
already contains the injury report, the weather and the game plan. Stripping the
margin out of a two-sided line and inverting it gives the market's own
projection, which is a far better starting point than any season-average model.

That alone would be circular: invert one line and you get back exactly what the
book said, so every edge would be zero by construction. The signal comes from
the fact that the lines are **not independent of each other**:

- A receiver's yardage and his catches are linked by yards per reception.
- A quarterback's passing yards are the same yards as his receivers' receiving
  yards, counted at the other end of the throw.
- A back's rushing yards are his carries times his yards per carry.

Books price those markets separately and they do not always land in the same
place. When a receiver's catch line implies more volume than his yardage line
does, one of them is wrong — and that disagreement is the edge. It is bounded
hard: reconciliation may move a projection **15% off its posted line and no
further**, a player's own implied rate is shrunk toward his position's rather
than replaced by it, and any leg claiming more than a 12-point edge is discarded
as a mapping error rather than trusted as an opportunity.

Two kinds of ticket come out, and the difference is not cosmetic:

- **Cross-game tickets** take one leg per game. The legs really are independent,
  so multiplying the prices gives what a book will actually quote you.
- **Same-game stacks** take several legs from one game because they hit
  together. These are priced through a correlation model, but every sportsbook
  reprices same-game parlays itself, so **the payout shown is an estimate** and
  your slip will differ. They are labelled separately for exactly that reason.

Probabilities are shaded down for leg count while the model is unproven, because
model error compounds: a model 10% optimistic per leg is 60% optimistic on a
five-leg ticket. And **negative expected value is reported, not hidden.** Most
parlays are bad bets; the board shows the least bad ones that clear $100.

## DraftKings

A lineup only means something inside a slate, so the week's games are sorted
into the slates DraftKings actually posts — Sunday Main, Sunday Early, and a
separate showdown for each night game — and each gets its own recommendations.

Every slate gets two builds, because a tournament and a double-up are different
problems:

|  | Double Up | Tournament |
|---|---|---|
| Goal | clear the cut | win outright |
| Optimises | floor | ceiling |
| Quarterback stack | **forbidden** | required |
| Max per team | 2 | 4 |
| Ownership | ignored | leverage premium |

In a double-up roughly the top half doubles their money and everyone above the
line wins the same, so upside past the cut is worthless and a stack is a single
point of failure. In a tournament the prizes sit at the very top, so a good score
is worthless and only a winning one counts — which needs correlation for a
ceiling and needs to be different, because a lineup the field also built splits
its prize with the field.

A lineup's floor and ceiling are the spread of the **lineup's total**, not the
sum of nine players' individual bests:

```
Var(total) = Σ variances + 2 Σ covariances
```

Uncorrelated players diversify each other away, pulling the total toward its
mean — a high floor and a modest ceiling. Correlated players do not, so the
total keeps its spread and reaches much further in both directions. That is the
arithmetic reason stacking wins tournaments, and computing it this way lets the
two builds be compared honestly on the same axis.

Ownership is **modelled, not scraped** — the field chases points per dollar, so
projected value predicts it well enough to separate chalk from leverage.

### Making the lineups exact

Drop a `DKSalaries.csv` into `data/salaries/`. Every DraftKings contest lobby
has an *Export to CSV* link, and two things come out of that file:

- **Salaries.** Without it they are estimated from the projections, so lineups
  will not sum to exactly $50,000 in DraftKings' own numbers. Treat them as a
  shape to copy rather than a lineup to enter.
- **Teams.** The odds feed does not say which team a player is on. Without it
  the model cannot tell a quarterback stacked with his own receiver from two
  unrelated players in the same game, which weakens the stacking the tournament
  lineups are built on.

The page says which of the two it used rather than letting an estimated lineup
pass for an exact one.

---

## Setup

The Action needs an [Odds API](https://the-odds-api.com/) key in the repository
secret **`TheOdds_API_Key`** — the same secret name the Brewers tracker uses.

Run **Probe data provider** from the Actions tab first. It reports which NFL
markets your key actually unlocks and what shape they come back in, which is
worth knowing before the update job spends credits discovering otherwise.

### Credits

The Odds API charges one credit per market per region on every event it prices.
Five prop markets across sixteen games is **80 credits a run**, so the schedule
is deliberately sparse — Thursday morning and twice on Sunday, about 640 a month.
The free tier is 500, so that schedule wants a paid tier; `update.js` keeps a
40-credit reserve and stops pricing games rather than running the quota to zero
mid-week. Game lines are cheap (two credits for the whole slate, in one bulk
call) and are fetched regardless.

To spend less, cut `PROP_MARKETS` in `scripts/update.js` or drop a scheduled run.

## Layout

```
index.html            the three tabs
assets/
  app.js              rendering and tab wiring
  tracker.js          bet log, grading, running totals
  style.css
lib/                  all pure, all tested, no fetching and no DOM
  odds.js             American/decimal, devig, parlay, expected value
  markets.js          parsing The Odds API's NFL payloads
  distribution.js     inverting a betting line into a projection
  reconcile.js        making a game's projections agree with each other
  projections.js      players and defences, floor to ceiling
  correlation.js      how two bet legs move together
  parlay.js           the $5 → $100 ticket builder
  scoring.js          DraftKings scoring and roster rules
  ownership.js        projected ownership and leverage
  lineups.js          the optimiser
  slates.js           sorting a week into DraftKings slates
  salaries.js         the DKSalaries.csv reader, and the fallback
  board.js            assembles a snapshot into both boards
scripts/
  update.js           fetch, rebuild, write            (npm run board)
  probe-nfl.js        what does this key unlock?       (npm run probe)
  make-demo.js        regenerate the offline fixture
data/
  demo-events.json    a week of events shaped like the real feed
  demo-salaries.csv   the matching DraftKings export
  salaries/           drop your own DKSalaries.csv here
```

Everything in `lib/` is pure and tested offline. The fixture is shaped exactly
like the real payload — bookmakers nested inside markets inside outcomes, prices
carrying a realistic hold, quoted CSV fields with commas in them — because a
fixture that is easier to parse than the real feed hides the bugs it exists to
catch.
