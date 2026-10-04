import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSitePath, safeReturnPath, handleSite } from './site.js';

const game = {
  event_id: 'e1', sport: 'americanfootball_nfl', game: 'Jacksonville Jaguars @ Cincinnati Bengals',
  home_team: 'Cincinnati Bengals', away_team: 'Jacksonville Jaguars', commence_time: '2026-10-04T17:00:00Z',
  slug: 'jacksonville-jaguars-at-cincinnati-bengals-2026-10-04', markets: {},
};
const snapRow = { sport: 'americanfootball_nfl', snapshot_date: '2026-10-02', taken_at: '2026-10-02T16:01:00.000Z', payload: JSON.stringify([game]) };

// D1 stand-in: answers by the first key the SQL contains.
const fakeDb = (answers) => ({
  prepare: (sql) => ({
    bind() { return this; },
    async all() { const k = Object.keys(answers).find((x) => sql.includes(x)); return { results: k ? answers[k] : [] }; },
    async first() { const k = Object.keys(answers).find((x) => sql.includes(x)); return k ? answers[k][0] ?? null : null; },
  }),
});
const env = (answers = {}) => ({ DB: fakeDb(answers), PUBLIC_SITE_URL: 'https://wepicksharp.com' });
const get = (path, e, nowMs = Date.parse('2026-10-02T18:00:00Z')) => handleSite(new Request(`https://wepicksharp.com${path}`), e, nowMs);

test('site paths', () => {
  for (const p of ['/odds', '/odds/nfl/x', '/tools/ev-calculator', '/sitemap.xml', '/robots.txt']) assert.equal(isSitePath(p), true, p);
  for (const p of ['/', '/record', '/api/odds', '/oddsx']) assert.equal(isSitePath(p), false, p);
});

test('return paths must be same-site paths', () => {
  assert.equal(safeReturnPath('/odds/nfl/x'), '/odds/nfl/x');
  assert.equal(safeReturnPath('//evil.com'), '/odds');
  assert.equal(safeReturnPath('https://evil.com'), '/odds');
  assert.equal(safeReturnPath(undefined), '/odds');
});

test('a known game page renders from the snapshot', async () => {
  const res = await get('/odds/nfl/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04?src=x_reply', env({ 'FROM odds_snapshots': [snapRow] }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Jacksonville Jaguars vs Cincinnati Bengals odds/);
  assert.match(html, /name="source" value="x_reply"/);
});

test('unknown sport or slug is 404; a slug older than the 14-day window is 410', async () => {
  assert.equal((await get('/odds/mlb/a-at-b-2026-10-04', env())).status, 404);
  assert.equal((await get('/odds/nfl/a-at-b-2026-10-04', env({ 'FROM odds_snapshots': [snapRow] }))).status, 404);
  assert.equal((await get('/odds/nfl/a-at-b-2026-09-01', env())).status, 410);
  assert.equal((await get('/odds/nfl/not-a-slug', env())).status, 404);
});

test('odds index renders the latest snapshot', async () => {
  const res = await get('/odds', env({ 'FROM odds_snapshots': [snapRow] }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /jacksonville-jaguars-at-cincinnati-bengals-2026-10-04/);
});

test('tools, sitemap and robots are served', async () => {
  const e = env({ 'FROM odds_snapshots': [snapRow] });
  assert.equal((await get('/tools/no-vig-calculator', e)).status, 200);
  assert.equal((await get('/tools/ev-calculator', e)).status, 200);
  assert.equal((await get('/tools/nope', e)).status, 404);
  const sm = await get('/sitemap.xml', e);
  assert.match(sm.headers.get('Content-Type'), /application\/xml/);
  const xml = await sm.text();
  assert.match(xml, /<loc>https:\/\/wepicksharp.com\/<\/loc>/);
  assert.match(xml, /\/odds\/nfl\/jacksonville-jaguars-at-cincinnati-bengals-2026-10-04/);
  assert.match(xml, /\/record/);
  const robots = await get('/robots.txt', e);
  assert.match(robots.headers.get('Content-Type'), /text\/plain/);
});
