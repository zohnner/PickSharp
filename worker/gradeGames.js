// Fetches final scores from ESPN's public scoreboard for games that have logged edges.
// Grading itself happens on read (record.js) from these stored scores.
import { etDate, espnScoreboardUrl, parseEspnScoreboard, findFinal, splitGame } from './grading.js';

const HOUR = 60 * 60 * 1000;
// A game is worth checking 4h after kickoff (overtime included), and given up on after
// 48h -- by then ESPN has a final or never will (postponed, or a name we can't match).
const GRADE_AFTER_MS = 4 * HOUR;
const GIVE_UP_AFTER_MS = 48 * HOUR;
const LOOKBACK_MS = 10 * 24 * HOUR;
// Free-plan limits are per invocation, shared with the edge scan and the post check:
// a few ESPN fetches and one bounded write batch keeps well inside them.
const MAX_FETCHES = 4;
const MAX_WRITES = 20;

// 08:00-10:59 UTC (4-7 AM ET): every game has finished and nothing kicks off, so the
// edge scan riding the same tick has no closing window to fill.
export function isGradingTick(ms) {
  const d = new Date(ms);
  return d.getUTCHours() >= 8 && d.getUTCHours() < 11 && d.getUTCMinutes() % 5 === 1;
}

const toSqlIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function runGrading(env, nowMs = Date.now(), deps = {}) {
  const fetchJson = deps.fetchJson || (async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    return res.json();
  });

  const { results: due } = await env.DB.prepare(
    `SELECT DISTINCT e.event_id, e.sport, e.game, e.commence_time
     FROM edges e LEFT JOIN game_results g ON g.event_id = e.event_id
     WHERE g.event_id IS NULL AND e.commence_time <= ? AND e.commence_time >= ?
     ORDER BY e.commence_time DESC`
  )
    .bind(toSqlIso(nowMs - GRADE_AFTER_MS), toSqlIso(nowMs - LOOKBACK_MS))
    .all();
  if (due.length === 0) return { checked: 0, graded: 0, unmatched: 0 };

  // One scoreboard fetch covers every game for that sport on that Eastern date.
  const groups = new Map();
  for (const ev of due) {
    const url = espnScoreboardUrl(ev.sport, etDate(ev.commence_time));
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(ev);
  }

  const writes = [];
  let graded = 0;
  let unmatched = 0;
  const errors = [];
  for (const [url, events] of [...groups].slice(0, MAX_FETCHES)) {
    let finals;
    try {
      finals = parseEspnScoreboard(await fetchJson(url));
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      continue;
    }
    for (const ev of events) {
      const teams = splitGame(ev.game);
      if (!teams) continue;
      const final = findFinal(finals, ev);
      if (final) {
        writes.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO game_results (event_id, sport, home_team, away_team, home_score, away_score, status)
             VALUES (?, ?, ?, ?, ?, ?, 'final')`
          ).bind(ev.event_id, ev.sport, teams.home, teams.away, final.homeScore, final.awayScore)
        );
        graded++;
      } else if (nowMs - Date.parse(ev.commence_time) > GIVE_UP_AFTER_MS) {
        writes.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO game_results (event_id, sport, home_team, away_team, status)
             VALUES (?, ?, ?, ?, 'unmatched')`
          ).bind(ev.event_id, ev.sport, teams.home, teams.away)
        );
        unmatched++;
        console.warn(`[grading] no ESPN final for ${ev.game} (${ev.commence_time}); marking unmatched`);
      }
    }
  }

  // Anything past the cap is picked up on the next tick.
  if (writes.length > 0) await env.DB.batch(writes.slice(0, MAX_WRITES));
  return {
    checked: due.length,
    graded,
    unmatched,
    ...(writes.length > MAX_WRITES && { deferred: writes.length - MAX_WRITES }),
    ...(errors.length > 0 && { errors }),
  };
}
