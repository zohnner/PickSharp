import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFunnelSummary } from './db.js';

test('funnel reports signups by source for the last 7 and 28 days', async () => {
  const seen = [];
  const db = {
    prepare: (sql) => ({
      bind() { return this; },
      async all() {
        seen.push(sql);
        if (sql.includes('GROUP BY source')) return { results: [{ source: 'x_reply', last_7: 3, last_28: 5 }, { source: null, last_7: 0, last_28: 1 }] };
        return { results: [] };
      },
      async first() { return { count: 0, total: 0, today: 0 }; },
    }),
  };
  const summary = await getFunnelSummary(db);
  assert.deepEqual(summary.signups_by_source, [
    { source: 'x_reply', last_7: 3, last_28: 5 },
    { source: 'unknown', last_7: 0, last_28: 1 },
  ]);
  assert.ok(seen.some((s) => s.includes("datetime('now', '-28 days')")));
});
