import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnOdds } from './espnOdds.js';

const side = (odds, line) => ({ close: { odds, ...(line !== undefined && { line }) }, open: { odds: '-110' } });

function event({ id = '401', date = '2026-09-27T17:00Z', odds } = {}) {
  return {
    id,
    date,
    competitions: [
      {
        competitors: [
          { homeAway: 'home', team: { displayName: 'Buffalo Bills' } },
          { homeAway: 'away', team: { displayName: 'Los Angeles Chargers' } },
        ],
        ...(odds !== undefined && { odds }),
      },
    ],
  };
}

const fullOdds = [
  {
    provider: { name: 'DraftKings' },
    moneyline: { home: side('-345'), away: side('+275') },
    pointSpread: { home: side('-115', '-7'), away: side('-105', '+7') },
    total: { over: side('-102', 'o50.5'), under: side('-118', 'u50.5') },
  },
];

test('maps an ESPN game to the Odds API shape the pick pipeline reads', () => {
  const [g] = parseEspnOdds({ events: [event({ odds: fullOdds })] }, 'americanfootball_nfl');
  assert.equal(g.id, 'espn-401');
  assert.equal(g.sport_key, 'americanfootball_nfl');
  assert.equal(g.commence_time, '2026-09-27T17:00:00Z');
  assert.equal(g.home_team, 'Buffalo Bills');
  assert.equal(g.away_team, 'Los Angeles Chargers');
  assert.equal(g.bookmakers.length, 1);
  assert.equal(g.bookmakers[0].key, 'draftkings');
  const market = (key) => g.bookmakers[0].markets.find((m) => m.key === key).outcomes;
  assert.deepEqual(market('h2h'), [
    { name: 'Buffalo Bills', price: -345 },
    { name: 'Los Angeles Chargers', price: 275 },
  ]);
  assert.deepEqual(market('spreads'), [
    { name: 'Buffalo Bills', price: -115, point: -7 },
    { name: 'Los Angeles Chargers', price: -105, point: 7 },
  ]);
  assert.deepEqual(market('totals'), [
    { name: 'Over', price: -102, point: 50.5 },
    { name: 'Under', price: -118, point: 50.5 },
  ]);
});

test('EVEN is +100 and a market with an unreadable side is dropped', () => {
  const odds = [
    {
      provider: { name: 'DraftKings' },
      moneyline: { home: side('EVEN'), away: side('-120') },
      pointSpread: { home: side('OFF', '-1'), away: side('-110', '+1') },
    },
  ];
  const [g] = parseEspnOdds({ events: [event({ odds })] }, 'americanfootball_nfl');
  assert.deepEqual(g.bookmakers[0].markets.map((m) => m.key), ['h2h']);
  assert.equal(g.bookmakers[0].markets[0].outcomes[0].price, 100);
});

test('a game without posted odds is kept (grounding only needs teams and kickoff) with no bookmakers', () => {
  const [g] = parseEspnOdds({ events: [event()] }, 'americanfootball_ncaaf');
  assert.deepEqual(g.bookmakers, []);
});

test('tolerates a missing or malformed payload', () => {
  assert.deepEqual(parseEspnOdds(null, 'americanfootball_nfl'), []);
  assert.deepEqual(parseEspnOdds({ events: [{ id: '1', competitions: [] }] }, 'americanfootball_nfl'), []);
});
