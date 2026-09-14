# DraftKings salary exports

Drop a player-list CSV here to make the lineup tab exact. Both sites are read:
DraftKings exports `DKSalaries.csv`, FanDuel exports `FanDuel-NFL-....csv`, and
the site is detected from the file header rather than its name — so you can keep
both in here at once and rename them however you like.

Every contest lobby has an **Export to CSV** link next to the player
list. The file it gives you is the one this folder wants — filename does not
matter, any `.csv` in here is read and merged.

Two things come out of that file, and only one of them is the salaries:

- **Salaries.** Without the export, salaries are estimated from the projections
  (see `lib/salaries.js`). The lineups are still sensibly constructed, but they
  will not sum to exactly $50,000 in DraftKings' own numbers, so treat them as
  a shape to copy rather than a lineup to enter.
- **Teams.** The odds feed does not say which team a player is on. The export
  does. Without it the model cannot tell a quarterback stacked with his own
  receiver from two unrelated players in the same game, so stacking — the whole
  basis of the tournament lineups — is degraded.

The export is per-slate, so grab the one for the slate you are entering.
