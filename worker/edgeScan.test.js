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

// F2: closing scans must leave credits for the discovery scans still to come before the
// quota resets. At 2026-09-02T16:06:00Z with the defaults (resetDay=1, perDay=9), Oct 1
// 00:00 UTC is 28.3292 days away; 9 * that = 254.96, ceil = 255 credits held back. (The
// old 18/day for the retired AI pipeline demanded 510 here -- more than the whole plan,
// so every scan was blocked early in each cycle.)
const FAR_FROM_RESET = Date.parse('2026-09-02T16:06:00Z');
const closingDue = () =>
  fakeDb({ 'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl', market: 'h2h' }], 'FROM edges WHERE commence_time >': [] });

test('F2: far from quota reset, a closing scan that would dip into the held-back credits is skipped', async () => {
  let fetched = false;
  const r = await runEdgeScan({ DB: closingDue() }, FAR_FROM_RESET, {
    ...deps(255), fetchSharpComparison: async () => { fetched = true; return []; }, // 255-1=254 < 255
  });
  assert.equal(r.reason, 'budget');
  assert.equal(fetched, false);
});

test('F2: the closing scan runs once remaining credits clear the held-back amount', async () => {
  const r = await runEdgeScan({ DB: closingDue() }, FAR_FROM_RESET, deps(256)); // 256-1=255 >= 255
  assert.equal(r.ran, true);
});

test('F2: discovery only needs the floor, even at the very start of a quota cycle', async () => {
  const cycleStart = Date.parse('2026-09-01T16:01:00Z');
  const r = await runEdgeScan({ DB: fakeDb({ 'FROM edges WHERE commence_time >': [] }) }, cycleStart, deps(40));
  assert.equal(r.ran, true); // 40 - 6 = 34 >= 30
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
  assert.ok(selectStmt.sql.includes(`ORDER BY commence_time ASC, (first_ev >= 0.02 AND NOT (market = 'h2h' AND first_price >= 3)) DESC`));

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

test('a spread that moved off the logged number still gets a close, from Pinnacle, adjusted and flagged by close_point', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z');
  const moved = {
    ...evt,
    bookmakers: [
      { key: 'pinnacle', markets: [{ key: 'spreads', outcomes: [
        { name: 'Green Bay Packers', price: 1.91, point: -6.5 }, { name: 'Atlanta Falcons', price: 1.91, point: 6.5 },
      ] }] },
      { key: 'betmgm', markets: [{ key: 'spreads', outcomes: [{ name: 'Green Bay Packers', price: 1.91, point: -6.5 }] }] },
    ],
  };
  const db = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl' }],
    'FROM edges WHERE commence_time >': [
      { id: 9, event_id: 'evt1', sport: 'americanfootball_nfl', market: 'spreads', outcome: 'Green Bay Packers', point: -4.5, book: 'betmgm' },
    ],
  });
  await runEdgeScan({ DB: db }, tick, { ...deps(400), fetchSharpComparison: async () => [moved] });
  const [close] = db.log.filter((s) => s.sql.includes('SET close_price'));
  assert.equal(close.args[0], null); // betmgm no longer offers -4.5
  assert.ok(close.args[1] > 0.5); // -4.5 is worth more than the -6.5 close
  assert.equal(close.args[3], -6.5); // close_point
  assert.equal(close.args.at(-1), 9);
});

test('a closing scan fetches only the markets its window has logged edges in (1 credit per market)', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z');
  const db = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl', market: 'h2h' }],
    'FROM edges WHERE commence_time >': [],
  });
  const asked = [];
  const r = await runEdgeScan({ DB: db }, tick, {
    ...deps(400),
    fetchSharpComparison: async (_e, sport, _ms, markets) => { asked.push([sport, markets]); return [evt]; },
  });
  assert.equal(r.kind, 'closing');
  assert.deepEqual(asked, [['americanfootball_nfl', 'h2h']]);
});

test('discovery always fetches all three markets', async () => {
  const asked = [];
  await runEdgeScan({ DB: fakeDb() }, DISCOVERY, {
    ...deps(400),
    fetchSharpComparison: async (_e, sport, _ms, markets) => { asked.push(markets); return []; },
  });
  assert.ok(asked.length > 0);
  for (const m of asked) assert.equal(m, 'h2h,spreads,totals');
});

test('when credits are tight, closing scans stop before discovery does', async () => {
  // Sep 26 23:46 UTC, reset on the 1st: ~4.01 days x 12/day -> 49 held back (floor 30).
  const tick = Date.parse('2026-09-26T23:46:00Z');
  const closingDb = fakeDb({ 'SELECT DISTINCT sport': [{ sport: 'americanfootball_ncaaf', market: 'h2h' }] });
  const closing = await runEdgeScan({ DB: closingDb, EDGE_PIPELINE_CREDITS_PER_DAY: '12' }, tick, deps(45));
  assert.equal(closing.reason, 'budget'); // 45 - 1 = 44 < 49
  const discovery = await runEdgeScan({ DB: fakeDb(), EDGE_PIPELINE_CREDITS_PER_DAY: '12' }, DISCOVERY, deps(45));
  assert.notEqual(discovery.reason, 'budget'); // discovery only needs the floor: 45 - 6 = 39 >= 30
});

test('the reserve uses the reset day detected from the balance history over the configured guess', async () => {
  // Oct 20, closing tick. Configured reset day 1 -> ~11.3 days x 6 = 68 held back, so 50
  // credits would skip. But the balance jumped on Sep 22, so the reset is ~1.3 days away
  // and only the 30 floor applies.
  const tick = Date.parse('2026-10-20T16:06:00Z');
  const history = [ // newest first, as the ORDER BY id DESC query returns
    { credits_remaining: 60, scanned_at: '2026-10-19 16:01:00' },
    { credits_remaining: 497, scanned_at: '2026-09-22 16:01:00' },
    { credits_remaining: 12, scanned_at: '2026-09-21 16:01:00' },
  ];
  const withHistory = fakeDb({
    'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl', market: 'h2h' }],
    'FROM edge_scans WHERE credits_remaining': history,
    'FROM edges WHERE commence_time >': [],
  });
  const r = await runEdgeScan({ DB: withHistory }, tick, deps(50));
  assert.equal(r.ran, true);
  const noHistory = fakeDb({ 'SELECT DISTINCT sport': [{ sport: 'americanfootball_nfl', market: 'h2h' }] });
  const skipped = await runEdgeScan({ DB: noHistory }, tick, deps(50));
  assert.equal(skipped.reason, 'budget');
});

test('closing scans only buy closes for gate-eligible (core) edges', async () => {
  const tick = Date.parse('2026-09-25T00:01:00Z');
  const db = fakeDb({ 'FROM edges WHERE commence_time >': [] });
  await runEdgeScan({ DB: db }, tick, deps(400));
  const due = db.log.find((s) => s.sql.includes('SELECT DISTINCT sport'));
  assert.ok(due.sql.endsWith(`AND (first_ev >= 0.02 AND NOT (market = 'h2h' AND first_price >= 3))`));
});

test('discovery adds the NBA from EDGE_NBA_START', async () => {
  const scanned = [];
  const fetch = async (_e, sport) => { scanned.push(sport); return []; };
  await runEdgeScan({ DB: fakeDb(), EDGE_NBA_START: '2026-10-20' }, DISCOVERY, { ...deps(400), fetchSharpComparison: fetch });
  assert.deepEqual(scanned, ['americanfootball_nfl', 'americanfootball_ncaaf']);
  scanned.length = 0;
  await runEdgeScan({ DB: fakeDb(), EDGE_NBA_START: '2026-10-20' }, Date.parse('2026-10-20T16:01:00Z'), { ...deps(400), fetchSharpComparison: fetch });
  assert.deepEqual(scanned, ['americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba']);
});
