// Monday recap of last week's graded edges, for X and the email list. Built from the same
// buildRecord output as /record, so the recap can never disagree with the public page.
// Every week is posted, winning or losing -- the record is only worth something unedited.
import { stats } from './record.js';
import { etDate } from './grading.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Mondays at 14:01 UTC (10 AM ET): after overnight grading has settled Sunday's games.
export function isRecapTick(ms) {
  const d = new Date(ms);
  return d.getUTCDay() === 1 && d.getUTCHours() === 14 && d.getUTCMinutes() === 1;
}

const shortDate = (yyyymmdd) =>
  new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

// The seven Eastern dates before `nowMs`'s Eastern date (Mon-Sun when run on a Monday).
export function lastWeekDates(nowMs) {
  return Array.from({ length: 7 }, (_, i) => etDate(nowMs - (7 - i) * DAY_MS));
}

// Returns null when no publish-bar edge settled last week -- nothing honest to post.
export function buildWeeklyRecap(record, nowMs) {
  const dates = lastWeekDates(nowMs);
  const inWeek = new Set(dates);
  const barEdges = record.edges.filter((e) => e.ev >= record.publishBar);
  const week = stats(barEdges.filter((e) => inWeek.has(etDate(e.commence_time))));
  if (week.wins + week.losses + week.pushes === 0) return null;
  return {
    weekStart: dates[0],
    label: `${shortDate(dates[0])}–${shortDate(dates[6])}`,
    barPct: Math.round(record.publishBar * 100),
    week,
    season: stats(barEdges),
  };
}

const signed = (x, digits) => `${x > 0 ? '+' : ''}${x.toFixed(digits)}`;
const recordLine = (s) => `${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ''}`;
const clvLine = (s) =>
  s.clv.count > 0
    ? `avg CLV ${signed(s.clv.avg * 100, 1)}% (${Math.round(s.clv.positiveShare * s.clv.count)} of ${s.clv.count} beat the close)`
    : null;

export function composeRecapTweet(recap, siteUrl) {
  const lines = [
    `📊 PickSharp weekly edge report (${recap.label})`,
    '',
    `${recap.barPct}%+ edges: ${recordLine(recap.week)}, ${signed(recap.week.units, 2)}u`,
    clvLine(recap.week),
    `Season: ${recordLine(recap.season)}, ${signed(recap.season.units, 2)}u`,
    '',
    `Every edge, wins and losses, nothing removed 👉 ${siteUrl}/record?ref=x_recap`,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function composeRecapEmail(recap, { siteUrl, unsubscribeLink, postalAddress }) {
  const link = `${siteUrl}/record?ref=email_recap`;
  const w = recap.week;
  const subject = `Weekly edge report: ${recordLine(w)}, ${signed(w.units, 2)}u (${recap.label})`;
  const rows = [
    ['Record', recordLine(w)],
    ['Units (1u per bet)', `${signed(w.units, 2)}u`],
    ['ROI', w.roi == null ? '—' : `${signed(w.roi * 100, 1)}%`],
    ['Closing line value', clvLine(w) ?? 'no closes captured'],
    ['Season to date', `${recordLine(recap.season)}, ${signed(recap.season.units, 2)}u`],
  ];
  const text = [
    `PickSharp weekly edge report, ${recap.label}`,
    `(${recap.barPct}%+ edges, graded against final scores)`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Every edge, wins and losses: ${link}`,
    '',
    'For entertainment only. Betting involves risk. Gambling problem? Call 1-800-GAMBLER. 21+.',
    postalAddress,
    `Unsubscribe: ${unsubscribeLink}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0a0a0a;font-family:Arial,sans-serif;color:#e5e5e5">
<div style="max-width:520px;margin:0 auto">
  <p style="margin:0 0 4px;font-size:20px;font-weight:bold;color:#ffffff">Weekly edge report</p>
  <p style="margin:0 0 20px;font-size:13px;color:#a3a3a3">${escapeHtml(recap.label)} · ${recap.barPct}%+ edges, graded against final scores</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 0;border-bottom:1px solid #262626;color:#a3a3a3">${escapeHtml(k)}</td><td style="padding:8px 0;border-bottom:1px solid #262626;text-align:right;color:#ffffff;font-weight:bold">${escapeHtml(v)}</td></tr>`
      )
      .join('')}
  </table>
  <a href="${escapeHtml(link)}" style="display:inline-block;margin-top:24px;padding:12px 20px;background:#c6971f;color:#171717;font-weight:bold;text-decoration:none;border-radius:6px">See every edge</a>
  <p style="margin:32px 0 0;font-size:11px;line-height:1.5;color:#737373">
    For entertainment only. Betting involves risk. Gambling problem? Call 1-800-GAMBLER. 21+.<br>
    ${escapeHtml(postalAddress)}<br>
    <a href="${escapeHtml(unsubscribeLink)}" style="color:#737373">Unsubscribe</a>
  </p>
</div></body></html>`;
  return { subject, text, html };
}
