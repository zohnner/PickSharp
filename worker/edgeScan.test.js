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

test('budget guard: skips and records when the scan would cross the reserve floor', async () => {
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

// F2: the reserve is prorated by days left until the monthly quota resets, not a flat
// floor, so far from reset day it demands far more than EDGE_SCAN_RESERVE alone. At
// 2026-09-02T16:01:00Z with the defaults (resetDay=1, perDay=18), Oct 1 00:00 UTC is
// 28 days 7h59m away = 28.332638... days; 18 * that = 509.9875, ceil = 510 credits --
// well above the 30-credit floor. EDGE_SPORTS has 2 sports = 6 credits per discovery scan.
const FAR_FROM_RESET = Date.parse('2026-09-02T16:01:00Z');

test('F2: prorated reserve (not the flat floor) skips a scan far from quota reset', async () => {
  const db = fakeDb();
  let fetched = false;
  const r = await runEdgeScan({ DB: db }, FAR_FROM_RESET, {
    ...deps(515), fetchSharpComparison: async () => { fetched = true; return []; }, // 515-6=509 < 510
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'budget');
  assert.equal(fetched, false);
});

test('F2: prorated reserve passes once remaining credits clear the prorated amount', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  const r = await runEdgeScan({ DB: db }, FAR_FROM_RESET, deps(516)); // 516-6=510 >= 510
  assert.equal(r.ran, true);
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
  // F5: a line that moves onto a different exact point re-upserts under a new identity, so
  // a stale row's own commence_time (e.g. a postponed game) must still refresh on every hit.
  assert.match(upserts[0].sql, /commence_time = excluded\.commence_time/);
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
  // F5: the close write also refreshes commence_time from the fresh comparison, not just
  // close_price/close_fair_prob, so a postponed/moved kickoff doesn't go stale.
  assert.match(closes[0].sql, /commence_time = \?/);
  assert.equal(closes[0].args[2], evt.commence_time); // commence_time refreshed
  assert.equal(closes[0].args.at(-1), 7); // WHERE id = 7
});

// F3/F4: with more open edges due a close refresh than MAX_WRITES_PER_KIND (15), the
// soonest kickoffs must get the close write, not an arbitrary cap-order slice. The real
// D1 query is trusted to do the sort (ORDER BY commence_time ASC); fakeDb hands back rows
// in that already-sorted form, standing in for what SQL would return.
const makeClosingEvt = (i, commenceIso) => ({
  id: `evt${i}`, sport_key: 'americanfootball_nfl', commence_time: commenceIso,
  home_team: 'Home', away_team: 'Away',
  bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 1.25 }, { name: 'Away', price: 4.5 }] }] },
    { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Away', price: 5.2 }] }] },
  ],
});

test('F3: open-edge query orders by soonest kickoff, and the cap keeps the soonest', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z');
  const TOTAL_OPEN = 17; // > MAX_WRITES_PER_KIND (15)
  const commenceFor = (i) => new Date(tick + (20 + i) * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const openEdgeRows = Array.from({ length: TOTAL_OPEN }, (_, i) => ({
    id: i + 1, event_id: `evt${i}`, market: 'h2h', outcome: 'Away', point: null, book: 'fanduel',
  }));
  const events = Array.from({ length: TOTAL_OPEN }, (_, i) => makeClosingEvt(i, commenceFor(i)));

  const db = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl' }],
    'FROM edges WHERE commence_time >': openEdgeRows,
  });
  await runEdgeScan({ DB: db }, tick, {
    ...deps(400), fetchSharpComparison: async () => events,
  });

  const selectStmt = db.log.find((s) => s.sql.includes('SELECT id, event_id'));
  assert.match(selectStmt.sql, /ORDER BY commence_time ASC/);

  const closes = db.log.filter((s) => s.sql.includes('SET close_price'));
  assert.equal(closes.length, 15);
  // ids 1..15 are the 15 soonest kickoffs (openEdgeRows is already commence-time ascending).
  assert.deepEqual(closes.map((c) => c.args.at(-1)), Array.from({ length: 15 }, (_, i) => i + 1));
});

test('F6: a D1 failure during the write phase still records the scan before rethrowing', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  const realBatch = db.batch.bind(db);
  let batchCalls = 0;
  db.batch = async (stmts) => {
    batchCalls += 1;
    if (batchCalls === 1) throw new Error('D1 write failed');
    return realBatch(stmts);
  };

  await assert.rejects(
    () => runEdgeScan({ DB: db }, DISCOVERY, deps(400)),
    /D1 write failed/
  );

  const rows = scanRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].args[2], 0); // ran = 0
  assert.equal(rows[0].args[3], 'db error');
});

test('F6: a failure recording the "db error" scan itself does not swallow the original error', async () => {
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  db.batch = async () => { throw new Error('D1 write failed'); };
  db.prepare = (sql) => {
    if (sql.includes('INSERT INTO edge_scans')) {
      return { bind() { return this; }, async run() { throw new Error('record-scan also failed'); } };
    }
    return {
      sql, args: [],
      bind(...args) { this.args = args; return this; },
      async all() { return { results: [] }; },
      async run() { return {}; },
    };
  };

  await assert.rejects(
    () => runEdgeScan({ DB: db }, DISCOVERY, deps(400)),
    /D1 write failed/ // the original error, not the recordScan failure
  );
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
