import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeScan } from './edgeScan.js';

// Minimal D1 stand-in: records every statement; SELECTs answer from `selects` by the
// first key (in insertion order) that the SQL contains.
function fakeDb(selects = {}) {
  const log = [];
  const stmt = (sql) => ({
    sql,
    args: [],
    bind(...args) { this.args = args; return this; },
    async all() {
      log.push({ sql, args: this.args });
      const key = Object.keys(selects).find((k) => sql.includes(k));
      return { results: key ? selects[key] : [] };
    },
    async run() { log.push({ sql, args: this.args }); return {}; },
  });
  return {
    log,
    prepare: (sql) => stmt(sql),
    async batch(stmts) { for (const s of stmts) log.push({ sql: s.sql, args: s.args }); return []; },
  };
}

const DISCOVERY = Date.parse('2026-09-24T16:01:00Z');
const QUIET = Date.parse('2026-09-24T16:06:00Z');

const evt = {
  id: 'evt1', sport_key: 'americanfootball_nfl', commence_time: '2026-09-25T00:15:00Z',
  home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons',
  bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Green Bay Packers', price: 1.25 }, { name: 'Atlanta Falcons', price: 4.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Atlanta Falcons', price: 5.2 }] }] },
  ],
};

const deps = (remaining, events = [evt]) => ({
  getRemainingCredits: async () => remaining,
  fetchSharpComparison: async (_env, sport) => (sport === 'americanfootball_nfl' ? events : []),
});

const scanRows = (db) => db.log.filter((s) => s.sql.includes('INSERT INTO edge_scans'));

test('does nothing on ticks from the generation cron', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, Date.parse('2026-09-24T13:15:00Z'), deps(400));
  assert.equal(r.ran, false);
  assert.equal(db.log.length, 0);
});

test('does nothing (and records nothing) when no scan is due', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, QUIET, deps(400));
  assert.equal(r.ran, false);
  assert.equal(scanRows(db).length, 0);
});

test('paused: records a skipped discovery scan and spends nothing', async () => {
  const db = fakeDb();
  let fetched = false;
  const r = await runEdgeScan({ DB: db, EDGE_SCAN_PAUSED: 'true' }, DISCOVERY, {
    ...deps(400), fetchSharpComparison: async () => { fetched = true; return []; },
  });
  assert.equal(r.ran, false);
  assert.equal(fetched, false);
  assert.equal(scanRows(db).length, 1);
  assert.equal(scanRows(db)[0].args[2], 0); // ran = 0
});

test('budget guard: skips and records when the scan would cross the reserve', async () => {
  const db = fakeDb();
  let fetched = false;
  const r = await runEdgeScan({ DB: db, EDGE_SCAN_RESERVE: '150' }, DISCOVERY, {
    ...deps(155), fetchSharpComparison: async () => { fetched = true; return []; },
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'budget');
  assert.equal(fetched, false);
  assert.equal(scanRows(db)[0].args[3], 'budget');
});

test('discovery scan upserts found edges and records the scan', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  const r = await runEdgeScan({ DB: db }, DISCOVERY, deps(400));
  assert.equal(r.ran, true);
  assert.equal(r.kind, 'discovery');
  assert.equal(r.found, 1);
  const upserts = db.log.filter((s) => s.sql.includes('INSERT INTO edges') && s.sql.includes('ON CONFLICT'));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].args[7], 'fanduel');
  assert.equal(scanRows(db)[0].args[2], 1); // ran = 1
});

test('closing scan runs only for sports with a logged kickoff in the window, and writes closes', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z'); // window [00:11, 00:16) holds the 00:15 kickoff
  const db = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl' }],
    'FROM edges WHERE commence_time >': [
      { id: 7, event_id: 'evt1', market: 'h2h', outcome: 'Atlanta Falcons', point: null, book: 'fanduel' },
    ],
  });
  const scanned = [];
  const r = await runEdgeScan({ DB: db }, tick, {
    ...deps(400), fetchSharpComparison: async (_e, sport) => { scanned.push(sport); return [evt]; },
  });
  assert.equal(r.kind, 'closing');
  assert.deepEqual(scanned, ['americanfootball_nfl']);
  const closes = db.log.filter((s) => s.sql.includes('SET close_price'));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].args[0], 5.2); // close_price
  assert.equal(closes[0].args.at(-1), 7); // WHERE id = 7
});

test('all sport fetches failing records a skipped scan and writes no edges', async () => {
  const db = fakeDb();
  const r = await runEdgeScan({ DB: db }, DISCOVERY, {
    getRemainingCredits: async () => 400,
    fetchSharpComparison: async () => { throw new Error('boom'); },
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'fetch failed');
  assert.equal(db.log.filter((s) => s.sql.includes('INSERT INTO edges ')).length, 0);
});
