import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, gameSlug, slugify, etIsoDate, sportPath, sportFromPath } from './oddsSnapshot.js';

const NOW = Date.parse('2026-10-02T16:01:00Z');
const mk = (key, markets) => ({ key, markets });
const evt = {
  id: 'e1', sport_key: 'americanfootball_nfl', commence_time: '2026-10-04T17:00:00Z',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars',
  bookmakers: [
    mk('pinnacle', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 1.95 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.95 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.91 }, { name: 'Under', point: 47.5, price: 1.91 }] },
      { key: 'h2h', outcomes: [{ name: 'Cincinnati Bengals', price: 1.38 }, { name: 'Jacksonville Jaguars', price: 3.2 }] },
    ]),
    mk('fanduel', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 2.1 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.8 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.87 }, { name: 'Over', point: 48.5, price: 2.05 }] },
      { key: 'h2h', outcomes: [{ name: 'Jacksonville Jaguars', price: 3.6 }] },
    ]),
    mk('draftkings', [
      { key: 'spreads', outcomes: [{ name: 'Cincinnati Bengals', point: -2.5, price: 1.87 }, { name: 'Jacksonville Jaguars', point: 2.5, price: 1.9 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: 1.93 }] },
    ]),
  ],
};

test('slugs use full team names and the ET kickoff date', () => {
  assert.equal(gameSlug(evt), 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04');
  // 02:30 UTC Sunday is still Saturday in ET.
  assert.equal(gameSlug({ ...evt, commence_time: '2026-10-04T02:30:00Z' }), 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-03');
  assert.equal(slugify('Texas A&M Aggies'), 'texas-a-and-m-aggies');
  assert.equal(slugify('San José State Spartans'), 'san-jose-state-spartans');
  assert.equal(slugify("Hawai'i Rainbow Warriors"), 'hawaii-rainbow-warriors');
  assert.equal(etIsoDate('2026-10-04T02:30:00Z'), '2026-10-03');
});

test('sport paths map both ways', () => {
  assert.equal(sportPath('americanfootball_ncaaf'), 'ncaaf');
  assert.equal(sportFromPath('nfl'), 'americanfootball_nfl');
  assert.equal(sportFromPath('mlb'), null);
});

test('each side gets the best and worst US price, at the main line, with the fair price', () => {
  const [g] = buildSnapshot([evt], NOW);
  assert.equal(g.slug, 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04');
  const bengals = g.markets.spreads.find((s) => s.outcome === 'Cincinnati Bengals');
  assert.deepEqual(
    { best: [bengals.best_price, bengals.best_book], worst: [bengals.worst_price, bengals.worst_book], books: bengals.books, point: bengals.point },
    { best: [2.1, 'fanduel'], worst: [1.87, 'draftkings'], books: 2, point: -2.5 }
  );
  assert.ok(Math.abs(bengals.fair_prob - 0.5) < 1e-9);
  // 2.10 * 0.5 - 1 = 5% on a spread: a core edge.
  assert.equal(bengals.is_edge, true);
  const jaguars = g.markets.spreads.find((s) => s.outcome === 'Jacksonville Jaguars');
  assert.equal(jaguars.is_edge, false);
});

test('off-main-line prices (Over 48.5) are ignored', () => {
  const [g] = buildSnapshot([evt], NOW);
  const over = g.markets.totals.find((s) => s.outcome === 'Over');
  assert.deepEqual([over.best_price, over.best_book, over.worst_price], [1.93, 'draftkings', 1.87]);
  assert.equal(over.is_edge, false); // 1.93 vs fair 2.00: worse than fair
  // No US book prices the Under, so that side is dropped.
  assert.equal(g.markets.totals.length, 1);
});

test('longshot moneylines are never edges, whatever the EV', () => {
  const [g] = buildSnapshot([evt], NOW);
  const jag = g.markets.h2h.find((s) => s.outcome === 'Jacksonville Jaguars');
  assert.ok(jag.best_price * jag.fair_prob - 1 > 0.02);
  assert.equal(jag.is_edge, false);
});

test('started games and markets Pinnacle does not price are left out', () => {
  assert.deepEqual(buildSnapshot([{ ...evt, commence_time: '2026-10-02T16:00:00Z' }], NOW), []);
  const noPin = { ...evt, bookmakers: evt.bookmakers.filter((b) => b.key !== 'pinnacle') };
  assert.deepEqual(buildSnapshot([noPin], NOW)[0].markets, {});
});

test('a full Saturday slate builds well inside the CPU budget', () => {
  const games = Array.from({ length: 80 }, (_, i) => ({
    ...evt, id: `e${i}`, home_team: `Home ${i}`, away_team: `Away ${i}`,
    bookmakers: [evt.bookmakers[0], ...Array.from({ length: 8 }, (_, b) => ({ ...evt.bookmakers[1], key: `book${b}` }))],
  }));
  const t0 = performance.now();
  for (let r = 0; r < 5; r++) JSON.stringify(buildSnapshot(games, NOW));
  const perRun = (performance.now() - t0) / 5;
  assert.ok(perRun < 5, `buildSnapshot + stringify took ${perRun.toFixed(2)}ms`);
});
