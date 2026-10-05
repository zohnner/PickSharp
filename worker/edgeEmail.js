// The daily edge email: every core edge the 16:01 UTC scan just found, free during the
// public trial. Pure: picks the edges and writes the message; email.js sends it.
import { isCoreEdge } from './coreEdge.js';
import { americanOdds, selectionLabel, BOOK_NAMES } from './record.js';

const FRESH_WITHIN_MS = 30 * 60 * 1000;
const sqlMs = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
const selKey = (r) => [r.event_id, r.market, r.outcome, r.point ?? 'null'].join('|');

// rows: edges rows. Only prices first seen in the scan that just ran (an older first price
// may be gone), on games not yet started, core only, best book per selection.
export function selectEmailEdges(rows, nowMs) {
  const best = new Map();
  for (const r of rows) {
    if (!isCoreEdge(r.first_ev, r.market, r.first_price)) continue;
    if (nowMs - sqlMs(r.first_seen_at) > FRESH_WITHIN_MS) continue;
    if (!(Date.parse(r.commence_time) > nowMs)) continue;
    const prev = best.get(selKey(r));
    if (!prev || r.first_ev > prev.first_ev) best.set(selKey(r), r);
  }
  return [...best.values()].sort((a, b) => b.first_ev - a.first_ev);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (decimal) => {
  const o = americanOdds(decimal);
  return o > 0 ? `+${o}` : `${o}`;
};
const kickoffEt = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  // Some ICU builds put a narrow no-break space before AM/PM; normalize it.
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(/ /g, ' ');
  return `${day}, ${time} ET`;
};
const line = (e) =>
  `${selectionLabel(e)} at ${BOOK_NAMES[e.book] || e.book} ${fmt(e.first_price)} (fair ${fmt(1 / e.first_fair_prob)}) · +${(e.first_ev * 100).toFixed(1)}% EV · ${kickoffEt(e.commence_time)}`;

export function composeEdgeEmail(edges, { siteUrl, unsubscribeLink, postalAddress }) {
  const top = edges[0];
  const subject = `${edges.length} edge${edges.length === 1 ? '' : 's'} today: ${selectionLabel(top)} ${fmt(top.first_price)} at ${BOOK_NAMES[top.book] || top.book}`;
  const record = `${siteUrl}/record?src=email`;
  const trial = 'Free during our public trial. Every edge is tracked with its result and closing line on our public record.';
  const text = [
    "Today's edges (prices as of the noon ET scan; confirm at the book before betting):",
    '',
    ...edges.map((e) => `• ${e.game}\n  ${line(e)}`),
    '',
    trial,
    record,
    '',
    '21+ · Gambling problem? Call 1-800-GAMBLER.',
    `Unsubscribe: ${unsubscribeLink}`,
    postalAddress,
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#171717;max-width:560px">
<p>Today's edges <span style="color:#737373">(prices as of the noon ET scan; confirm at the book before betting)</span>:</p>
<ul>${edges.map((e) => `<li style="margin-bottom:10px"><strong>${escapeHtml(e.game)}</strong><br>${escapeHtml(line(e))}</li>`).join('')}</ul>
<p>${escapeHtml(trial)} <a href="${escapeHtml(record)}">See the record</a>.</p>
<p style="color:#737373;font-size:12px">21+ · Gambling problem? Call 1-800-GAMBLER.<br><a href="${escapeHtml(unsubscribeLink)}">Unsubscribe</a> · ${escapeHtml(postalAddress)}</p></div>`;
  return { subject, text, html };
}
