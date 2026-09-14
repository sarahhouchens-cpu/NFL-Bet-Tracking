/**
 * Wires the three tabs to their data.
 *
 * The tracker runs entirely in the browser off localStorage. The other two tabs
 * render JSON that the GitHub Action built — no odds are fetched from the page,
 * because that would put an API key in public source.
 */

import * as tracker from './tracker.js';
import { formatAmerican } from '../lib/odds.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const money = (n, sign = false) => {
  const value = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = n < 0 ? '-$' : sign ? '+$' : '$';
  return `${prefix}${value}`;
};
const percent = (n, digits = 1) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);

/* ------------------------------------------------------------------ tabs */

const TABS = [
  { tab: 'tab-tracker', panel: 'panel-tracker' },
  { tab: 'tab-board', panel: 'panel-board' },
  { tab: 'tab-dfs', panel: 'panel-dfs' },
];

function showTab(id) {
  for (const entry of TABS) {
    const isActive = entry.tab === id;
    const tab = $(entry.tab);
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    $(entry.panel).hidden = !isActive;
  }
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}

for (const entry of TABS) {
  $(entry.tab).addEventListener('click', () => showTab(entry.tab));
}
// Arrow keys move between tabs, which is what a tablist is expected to do.
$('tab-tracker').parentElement.addEventListener('keydown', (event) => {
  const index = TABS.findIndex((t) => t.tab === document.activeElement?.id);
  if (index < 0) return;
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!delta) return;
  event.preventDefault();
  const next = TABS[(index + delta + TABS.length) % TABS.length];
  $(next.tab).focus();
  showTab(next.tab);
});

/* --------------------------------------------------------------- tracker */

let bets = tracker.load();
let filter = 'all';

function persist() {
  if (!tracker.save(bets)) {
    showFormError('Could not save — this browser is blocking local storage.');
  }
}

function showFormError(message) {
  const node = $('form-error');
  node.textContent = message;
  node.hidden = !message;
}

function renderStats() {
  const s = tracker.summarize(bets);
  const row = $('stat-row');
  row.replaceChildren();

  const beatingPrices =
    s.winRate != null && s.breakEven != null
      ? s.winRate >= s.breakEven
      : null;

  const cards = [
    {
      k: 'Profit',
      v: money(s.profit, s.profit > 0),
      cls: s.profit > 0 ? 'up' : s.profit < 0 ? 'down' : '',
      sub: `${money(s.staked)} staked and settled`,
    },
    {
      k: 'Return',
      v: s.roi == null ? '—' : percent(s.roi),
      cls: s.roi > 0 ? 'up' : s.roi < 0 ? 'down' : '',
      sub: s.roi == null ? 'grade a bet to start' : 'per dollar risked',
    },
    {
      k: 'Record',
      v: `${s.won}-${s.lost}${s.pushed ? `-${s.pushed}` : ''}`,
      cls: '',
      sub: s.winRate == null ? 'nothing settled yet' : `${percent(s.winRate)} win rate`,
    },
    {
      k: 'Break-even',
      v: s.breakEven == null ? '—' : percent(s.breakEven),
      cls: beatingPrices == null ? '' : beatingPrices ? 'up' : 'down',
      sub:
        beatingPrices == null
          ? 'what your prices demand'
          : beatingPrices
          ? 'you are beating your prices'
          : 'your prices need more than this',
    },
    {
      k: 'Open',
      v: String(s.open),
      cls: '',
      sub: s.open ? `${money(s.openStake)} at risk` : 'nothing pending',
    },
  ];

  for (const card of cards) {
    const node = el('div', 'stat');
    node.append(el('div', 'k', card.k));
    node.append(el('div', `v ${card.cls}`.trim(), card.v));
    node.append(el('div', 'sub', card.sub));
    row.append(node);
  }

  const strip = $('bankroll-strip');
  strip.replaceChildren();
  if (!bets.length) {
    strip.append(el('span', '', 'No bets logged yet'));
  } else {
    const profit = el('span', '');
    profit.append(document.createTextNode('P&L '));
    profit.append(el('strong', s.profit > 0 ? 'up' : s.profit < 0 ? 'down' : '', money(s.profit, s.profit > 0)));
    strip.append(profit);

    const record = el('span', '');
    record.append(document.createTextNode('Record '));
    record.append(el('strong', '', `${s.won}-${s.lost}${s.pushed ? `-${s.pushed}` : ''}`));
    strip.append(record);

    if (s.open) {
      const open = el('span', '');
      open.append(document.createTextNode('Open '));
      open.append(el('strong', '', String(s.open)));
      strip.append(open);
    }
  }
}

function matchesFilter(bet) {
  if (filter === 'all') return true;
  if (filter === 'open') return bet.result === 'open';
  if (filter === 'won' || filter === 'lost') return bet.result === filter;
  return bet.type === filter;
}

function renderBets() {
  const list = $('bet-list');
  list.replaceChildren();

  const visible = bets
    .filter(matchesFilter)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.loggedAt).localeCompare(String(a.loggedAt)));

  if (!visible.length) {
    list.append(
      el(
        'div',
        'empty',
        bets.length ? 'No bets match this filter.' : 'Nothing logged yet. Add a bet above and it will show up here.'
      )
    );
    return;
  }

  for (const bet of visible) {
    const row = el('div', `bet ${bet.result}`);
    row.append(el('div', 'edge'));

    const main = el('div', 'bet-main');
    main.append(el('div', 'bet-desc', bet.description));

    const meta = el('div', 'bet-meta');
    meta.append(el('span', 'tag', bet.type));
    meta.append(el('span', '', bet.date));
    meta.append(el('span', '', `${formatAmerican(bet.odds)} · ${money(bet.stake)}`));
    meta.append(el('span', '', `pays ${money(tracker.payoutOf(bet))}`));
    if (bet.book) meta.append(el('span', '', bet.book));
    main.append(meta);
    row.append(main);

    const right = el('div', 'bet-right');
    const profit = tracker.profitOf(bet);
    const pl = el(
      'div',
      `bet-pl ${bet.result === 'open' || bet.result === 'push' ? 'flat' : profit > 0 ? 'up' : 'down'}`,
      bet.result === 'open' ? 'open' : bet.result === 'push' ? 'push' : money(profit, profit > 0)
    );
    right.append(pl);

    const grade = el('div', 'grade');
    if (bet.result === 'open') {
      grade.append(gradeButton('Won', 'w', () => setResult(bet.id, 'won')));
      grade.append(gradeButton('Lost', 'l', () => setResult(bet.id, 'lost')));
      grade.append(gradeButton('Push', '', () => setResult(bet.id, 'push')));
    } else {
      grade.append(gradeButton('Undo', '', () => setResult(bet.id, 'open')));
    }
    grade.append(gradeButton('×', 'x', () => removeBet(bet.id), `Delete: ${bet.description}`));
    right.append(grade);
    row.append(right);

    list.append(row);
  }
}

function gradeButton(label, cls, onClick, title) {
  const button = el('button', cls, label);
  button.type = 'button';
  if (title) button.title = title;
  button.setAttribute('aria-label', title ?? label);
  button.addEventListener('click', onClick);
  return button;
}

function setResult(id, result) {
  bets = bets.map((bet) => (bet.id === id ? { ...bet, result } : bet));
  persist();
  renderStats();
  renderBets();
}

function removeBet(id) {
  const bet = bets.find((b) => b.id === id);
  if (bet && !confirm(`Delete "${bet.description}"?`)) return;
  bets = bets.filter((b) => b.id !== id);
  persist();
  renderStats();
  renderBets();
}

$('bet-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const { bet, error } = tracker.parseBet(data);
  if (error) {
    showFormError(error);
    return;
  }
  showFormError('');
  bets = [bet, ...bets];
  persist();
  renderStats();
  renderBets();
  event.target.reset();
  $('bet-date').value = tracker.today();
  $('bet-description').focus();
});

$('filters').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const other of $('filters').querySelectorAll('.chip')) {
    other.classList.toggle('is-active', other === chip);
  }
  renderBets();
});

$('export-json').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(bets, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `nfl-bets-${tracker.today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

$('import-json').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming)) throw new Error('not a list');
    // Merge rather than replace, and skip anything already present, so
    // importing the same file twice does not double the record.
    const known = new Set(bets.map((b) => b.id));
    const added = incoming.filter((b) => b && typeof b.id === 'string' && !known.has(b.id));
    bets = [...added, ...bets];
    persist();
    renderStats();
    renderBets();
    showFormError(added.length ? '' : 'Nothing new in that file.');
  } catch {
    showFormError('That file could not be read as an export.');
  }
  event.target.value = '';
});

$('clear-all').addEventListener('click', () => {
  if (!bets.length) return;
  if (!confirm(`Delete all ${bets.length} bets? This cannot be undone.`)) return;
  bets = [];
  persist();
  renderStats();
  renderBets();
});

/* ----------------------------------------------------------- value board */

function ticketNode(ticket, { estimated = false } = {}) {
  const node = el('div', 'ticket');

  const head = el('div', 'ticket-head');
  const left = el('div');
  left.append(el('div', 'ticket-pay', money(ticket.payout)));
  left.append(
    el(
      'div',
      'ticket-price',
      `${formatAmerican(ticket.americanOdds)} · ${ticket.legs.length} legs · ${money(ticket.stake)} stake`
    )
  );
  head.append(left);

  const stats = el('div', 'ticket-stats');
  stats.append(labelled('Win chance', percent(ticket.probability)));
  const ev = ticket.expectedValue;
  stats.append(labelled('Expected value', money(ev, ev > 0), ev > 0 ? 'up' : 'down'));
  if (ticket.correlationAdjustment && Math.abs(ticket.correlationAdjustment - 1) > 0.02) {
    stats.append(labelled('Correlation', `×${ticket.correlationAdjustment.toFixed(2)}`));
  }
  head.append(stats);
  node.append(head);

  const legs = el('ul', 'legs');
  for (const leg of ticket.legs) {
    const item = el('li');
    item.append(el('span', 'leg-name', leg.description));
    const right = el('span', 'leg-right');
    right.append(el('span', 'leg-odds', formatAmerican(leg.americanOdds)));
    if (leg.book) right.append(el('span', '', leg.book));
    if (leg.edge != null) {
      // Rounding a tiny edge to one decimal can produce "-0.0", which reads as
      // a loss rather than as the "no disagreement" it actually is.
      const rounded = Number(leg.edge.toFixed(1));
      const tone = rounded > 0 ? 'up' : rounded < 0 ? 'down' : '';
      const text = rounded === 0 ? 'priced fairly' : `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pts`;
      right.append(el('span', `leg-edge ${tone}`.trim(), text));
    } else {
      right.append(el('span', '', 'no second side'));
    }
    item.append(right);
    legs.append(item);
  }
  node.append(legs);

  const foot = el('div', 'ticket-foot');
  foot.append(el('span', '', ticket.note ?? ''));
  foot.append(el('span', '', estimated ? 'Book will reprice' : `${ticket.gameCount} games`));
  node.append(foot);

  return node;
}

function labelled(key, value, cls) {
  const span = el('span', '');
  span.append(document.createTextNode(`${key} `));
  span.append(el('b', cls, value));
  return span;
}

/**
 * Say plainly when a board was built from the offline fixture.
 *
 * The fixture's players do not exist. It ships built so the site works on a
 * fresh clone before the Action has ever run, and that is only defensible if
 * nobody can mistake it for a real board.
 */
function demoNotice(target, what) {
  const notice = el('div', 'notice warn');
  notice.append(el('b', '', 'Sample data. '));
  notice.append(
    document.createTextNode(
      `These ${what} were built from the offline fixture — the players are invented and the prices are not real. Run the "Update boards" workflow with an Odds API key to replace them.`
    )
  );
  $(target).replaceChildren(notice);
}

function renderBoard(board) {
  $('board-updated').textContent = board.generatedAt
    ? `Built ${new Date(board.generatedAt).toLocaleString()}`
    : 'Unknown';
  $('board-slate').textContent = `${board.games.length} games priced`;

  const best = board.tickets[0];
  if (best) {
    $('board-headline').textContent = `Best ticket returns ${money(best.payout)} on ${money(best.stake)}`;
    const positive = board.tickets.filter((t) => t.expectedValue > 0).length;
    $('board-explainer').textContent = positive
      ? `${positive} of ${board.tickets.length} tickets price out as positive expected value against the market's own devigged opinion.`
      : `None of these price out as positive expected value — the board is showing the least bad way to reach ${money(board.minPayout)}.`;
  } else {
    $('board-headline').textContent = 'No tickets reach $100 right now';
    $('board-explainer').textContent =
      'Either no games are close enough for props to be posted, or nothing in the current prices combines into a ticket that clears the floor.';
  }

  const tickets = $('tickets');
  tickets.replaceChildren();
  if (!board.tickets.length) {
    tickets.append(el('div', 'empty', 'No cross-game tickets clear $100 on the current board.'));
  } else {
    for (const ticket of board.tickets) tickets.append(ticketNode(ticket));
  }

  const stacks = $('stacks');
  stacks.replaceChildren();
  if (!board.stacks?.length) {
    stacks.append(el('div', 'empty', 'No same-game stacks on this board.'));
  } else {
    for (const stack of board.stacks) stacks.append(ticketNode(stack, { estimated: true }));
  }
}

/* ------------------------------------------------------------ draftkings */

let dfsData = null;
let activeSite = null;
let activeSlate = null;

function lineupNode(lineup, title, blurb, cap = null) {
  const node = el('div', 'lineup');

  const head = el('div', 'lineup-head');
  head.append(el('div', 't', title));
  const stats = el('div', 's');
  stats.append(labelled('Proj', lineup.points.toFixed(1)));
  stats.append(labelled('Floor', lineup.floor.toFixed(1)));
  stats.append(labelled('Ceiling', lineup.ceiling.toFixed(1)));
  stats.append(
    labelled('Salary', `$${lineup.salary.toLocaleString('en-US')}${cap ? ` / ${(cap / 1000).toFixed(0)}k` : ''}`)
  );
  head.append(stats);
  node.append(head);

  const stackedIds = new Set();
  if (lineup.stack) {
    const qb = lineup.players.find((p) => p.position === 'QB');
    if (qb) {
      for (const player of lineup.players) {
        if (player.team === qb.team && ['QB', 'WR', 'TE'].includes(player.position)) {
          stackedIds.add(player.playerId);
        }
      }
    }
  }

  const table = el('table', 'roster');
  const body = el('tbody');
  for (const player of lineup.players) {
    const row = el('tr', stackedIds.has(player.playerId) ? 'stacked' : '');
    row.append(el('td', 'slot', player.slot));
    const who = el('td', 'who');
    who.append(document.createTextNode(player.playerName));
    // A defence's name already contains its team, so the tag would just repeat
    // it back ("San Francisco 49ers San Francisco 49ers").
    const repeats = player.team && player.playerName.toLowerCase().includes(String(player.team).toLowerCase());
    if (player.team && !repeats) who.append(el('span', 'team', player.team));
    row.append(who);
    // A DraftKings captain is charged 1.5x; a FanDuel MVP is not. The lineup's
    // own total already reflects the site's rule, so the row shows the same
    // figure rather than the list price, which would not add up on screen.
    const charged = Math.round(player.salary * (lineup.chargesCaptainPremium ? player.multiplier ?? 1 : 1));
    row.append(el('td', 'num', `$${charged.toLocaleString('en-US')}`));
    row.append(el('td', 'num pts', (player.points ?? 0).toFixed(1)));
    row.append(el('td', 'own', `${(player.ownership ?? 0).toFixed(0)}%`));
    body.append(row);
  }
  table.append(body);
  node.append(table);

  const note = el('div', 'stack-note');
  if (lineup.stack) {
    note.append(document.createTextNode('Stack: '));
    note.append(el('b', '', lineup.stack.label));
  } else {
    note.append(document.createTextNode(blurb));
  }
  node.append(note);

  return node;
}

function renderSlate(recommendation) {
  const body = $('slate-body');
  body.replaceChildren();

  const roster = recommendation.tournament[0]?.players.length ?? recommendation.doubleUp[0]?.players.length ?? 0;
  const heading = el('div', 'sec-head');
  heading.append(
    el(
      'div',
      'eyebrow',
      recommendation.slate.format === 'showdown'
        ? `${recommendation.captainLabel ?? 'Captain'} at 1.5× · ${roster} roster spots`
        : `Classic · ${roster} roster spots`
    )
  );
  heading.append(el('h2', '', recommendation.slate.name));
  heading.append(
    el(
      'p',
      '',
      `${recommendation.poolSize} players priced${
        recommendation.slate.startsAt ? ` · first kick-off ${new Date(recommendation.slate.startsAt).toLocaleString()}` : ''
      }`
    )
  );
  body.append(heading);

  for (const [key, title, blurb] of [
    ['tournament', 'Tournament', 'Built for a ceiling: correlated and contrarian.'],
    ['doubleUp', 'Double Up', 'Built for a floor: no stack, spread across teams.'],
  ]) {
    const lineups = recommendation[key] ?? [];
    const section = el('section');
    const head = el('div', 'sec-head');
    head.append(el('div', 'eyebrow', key === 'tournament' ? 'GPP' : 'Cash game'));
    head.append(el('h2', '', title));
    head.append(el('p', '', blurb));
    section.append(head);

    const grid = el('div', 'lineup-grid');
    if (!lineups.length) {
      grid.append(el('div', 'empty', 'No lineup could be built for this slate.'));
    } else {
      lineups.forEach((lineup, i) =>
        grid.append(lineupNode(lineup, `${title} #${i + 1}`, blurb, recommendation.salaryCap))
      );
    }
    section.append(grid);
    body.append(section);
  }
}

/**
 * Render the site switch, then hand off to the slate list for whichever site is
 * selected.
 *
 * The two sites are kept entirely separate rather than merged into one list.
 * They price, score and roster differently, so a slate that exists on both is
 * still two different problems, and showing one set of lineups under a single
 * heading would invite entering a DraftKings build on FanDuel.
 */
function renderDfs(data) {
  dfsData = data;

  const sitePicker = $('site-picker');
  const slatePicker = $('slate-picker');
  sitePicker.replaceChildren();
  slatePicker.replaceChildren();

  const sites = Object.values(data.sites ?? {});
  if (!sites.length) {
    $('slate-body').replaceChildren(el('div', 'empty', 'No lineup data in this build.'));
    return;
  }

  // Prefer a site that actually produced something, so the tab does not open on
  // an empty one when only the other has slates.
  const preferred = sites.find((s) => s.slates.length) ?? sites[0];

  for (const site of sites) {
    const chip = el('button', 'chip', site.siteName);
    chip.type = 'button';
    chip.append(el('span', 'cap', `$${(site.salaryCap / 1000).toFixed(0)}k cap`));
    chip.addEventListener('click', () => {
      for (const other of sitePicker.querySelectorAll('.chip')) other.classList.toggle('is-active', other === chip);
      selectSite(site);
    });
    if (site === preferred) chip.classList.add('is-active');
    sitePicker.append(chip);
  }

  selectSite(preferred);
}

function selectSite(site) {
  activeSite = site;
  const picker = $('slate-picker');
  picker.replaceChildren();
  $('dfs-notice').replaceChildren();

  const notices = [];
  if (dfsData?.demo) {
    notices.push([
      'Sample data. ',
      'These lineups were built from the offline fixture — the players are invented and the prices are not real. Run the "Update boards" workflow with an Odds API key to replace them.',
    ]);
  }
  if (site.salarySource !== site.site) {
    notices.push([
      `${site.siteName} salaries are estimated. `,
      `No ${site.siteName} export was found, so salaries are modelled against the $${site.salaryCap.toLocaleString('en-US')} cap and player teams are unknown — which weakens the stacking the tournament lineups depend on. Drop that site's player-list CSV into data/salaries/ to make these exact.`,
    ]);
  }
  if (notices.length) {
    $('dfs-notice').replaceChildren(
      ...notices.map(([bold, rest]) => {
        const notice = el('div', 'notice warn');
        notice.append(el('b', '', bold));
        notice.append(document.createTextNode(rest));
        return notice;
      })
    );
  }

  if (!site.slates.length) {
    const body = $('slate-body');
    body.replaceChildren(
      el('div', 'empty', `No ${site.siteName} slates could be built yet.`)
    );
    appendSkipped(body, site);
    return;
  }

  site.slates.forEach((recommendation, index) => {
    const chip = el('button', `chip${index === 0 ? ' is-active' : ''}`, recommendation.slate.name);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      activeSlate = recommendation.slate.id;
      for (const other of picker.querySelectorAll('.chip')) other.classList.toggle('is-active', other === chip);
      renderSlate(recommendation);
      appendSkipped($('slate-body'), site);
    });
    picker.append(chip);
  });

  activeSlate = site.slates[0].slate.id;
  renderSlate(site.slates[0]);
  appendSkipped($('slate-body'), site);
}

/**
 * List the slates that were deliberately not built, with the reason.
 *
 * A slate silently missing looks like a bug. A slate that says why it is
 * missing — props not posted yet, or no real positions to fill a tight end slot
 * with — tells you whether to wait or to go and export a file.
 */
function appendSkipped(body, site) {
  if (!site.skipped?.length) return;
  const section = el('section');
  const head = el('div', 'sec-head');
  head.append(el('div', 'eyebrow', 'Not built'));
  head.append(el('h2', '', `Other ${site.siteName} slates`));
  section.append(head);

  const list = el('div', 'explain');
  const ul = el('ul');
  for (const skip of site.skipped) {
    const li = el('li');
    li.append(el('strong', '', skip.name));
    li.append(document.createTextNode(` — ${skip.reason}`));
    ul.append(li);
  }
  list.append(ul);
  section.append(list);
  body.append(section);
}

/* ------------------------------------------------------------------ boot */

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.json();
}

function failureNotice(target, what) {
  const notice = el('div', 'notice warn');
  notice.append(el('b', '', `No ${what} data yet. `));
  notice.append(
    document.createTextNode(
      'Run the "Update boards" workflow, or build it locally with npm run board:demo to see the site working against the sample fixture.'
    )
  );
  $(target).replaceChildren(notice);
}

async function boot() {
  $('bet-date').value = tracker.today();
  renderStats();
  renderBets();

  const requested = location.hash.slice(1);
  if (TABS.some((t) => t.tab === requested)) showTab(requested);

  const [board, dfs] = await Promise.allSettled([
    loadJson('data/board-latest.json'),
    loadJson('data/lineups-latest.json'),
  ]);

  if (board.status === 'fulfilled') {
    renderBoard(board.value);
    if (board.value.demo) demoNotice('board-notice', 'tickets');
    $('foot-meta').textContent = `Board built ${new Date(board.value.generatedAt).toLocaleString()} from ${board.value.games.length} games.`;
  } else {
    failureNotice('board-notice', 'value board');
    $('board-headline').textContent = 'No board built yet';
    $('board-explainer').textContent = 'The tracker works regardless — it needs no data files.';
    $('board-updated').textContent = 'Not built';
  }

  if (dfs.status === 'fulfilled') {
    renderDfs(dfs.value);
    if (dfs.value.demo) demoNotice('dfs-notice', 'lineups');
  } else failureNotice('dfs-notice', 'DraftKings');
}

boot();
