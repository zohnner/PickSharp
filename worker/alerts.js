// Owner alerts: a plain email to the first ADMIN_EMAILS address when an automated job
// fails, so a broken slot is noticed the same day instead of whenever someone looks.
import { logUsage } from './usage.js';

// Outcomes that are the pipeline working as designed, not failures worth an email.
const EXPECTED_POST_REASONS = [/^Already posted/, /^Posting is paused/];

export function isPostFailure(result) {
  if (!result || result.posted) return false;
  return !EXPECTED_POST_REASONS.some((re) => re.test(result.reason || ''));
}

export function adminAlertRecipient(env) {
  const first = (env.ADMIN_EMAILS || '').split(',')[0].trim().toLowerCase();
  return first || null;
}

// Never throws: an alert failing must not mask or add to the failure it reports.
// Returns { sent, reason? }; a failed send is also logged here, since most callers
// ignore the result and a silently failing alert looks exactly like no failure.
export async function sendAdminAlert(env, key, subject, lines) {
  const result = await trySendAdminAlert(env, key, subject, lines);
  if (!result.sent && result.reason !== 'already alerted today') {
    console.error(`[alert] "${key}" not sent: ${result.reason}`);
  }
  return result;
}

async function trySendAdminAlert(env, key, subject, lines) {
  try {
    const to = adminAlertRecipient(env);
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) return { sent: false, reason: 'email not configured' };

    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO admin_alerts (date, alert_key) VALUES (date('now', '-4 hours'), ?)`
    )
      .bind(key)
      .run();
    if (claim.meta.changes === 0) return { sent: false, reason: 'already alerted today' };

    const text = [...lines, '', `Admin panel: ${env.PUBLIC_SITE_URL || ''}/admin`].join('\n');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: `[PickSharp alert] ${subject}`, text }),
    });
    if (!res.ok) {
      // Release the claim so a later occurrence today can try again.
      await env.DB.prepare(`DELETE FROM admin_alerts WHERE date = date('now', '-4 hours') AND alert_key = ?`)
        .bind(key)
        .run();
      return { sent: false, reason: `Resend ${res.status}: ${await res.text()}` };
    }
    await logUsage(env, 'email');
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
