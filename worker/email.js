// Daily free-pick email via Resend (https://resend.com/docs/api-reference/emails/send-batch-emails).
// Everything here is off until the owner configures it -- see missingEmailConfig.
import { logUsage } from './usage.js';

const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch';
const RESEND_BATCH_LIMIT = 100;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// CAN-SPAM requires a physical postal address in every commercial email, so a missing
// EMAIL_POSTAL_ADDRESS blocks sending just like a missing API key does.
export function missingEmailConfig(env) {
  return ['RESEND_API_KEY', 'UNSUBSCRIBE_SECRET', 'EMAIL_FROM', 'EMAIL_POSTAL_ADDRESS'].filter((k) => !env[k]);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Signed rather than stored: no token column to migrate, and a link can't be forged to
// unsubscribe someone else. Rotating UNSUBSCRIBE_SECRET invalidates old links.
export function unsubscribeToken(secret, email) {
  return hmacHex(secret, `unsubscribe:${email}`);
}

export async function verifyUnsubscribeToken(secret, email, token) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const expected = await unsubscribeToken(secret, email);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export async function unsubscribeUrl(env, email) {
  const token = await unsubscribeToken(env.UNSUBSCRIBE_SECRET, email);
  return `${env.PUBLIC_SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}

export function composeDailyEmail(pick, { siteUrl, unsubscribeLink, postalAddress }) {
  const picksLink = `${siteUrl}/picks?ref=email`;
  const subject = `Today's free pick: ${pick.pick_text}`;
  const when = pick.game_time ? ` · ${pick.game_time}` : '';

  const text = [
    `Today's free pick from ${pick.author}:`,
    '',
    pick.pick_text,
    `${pick.game}${when}`,
    '',
    `See the rest of today's picks: ${picksLink}`,
    '',
    'For entertainment only. Betting involves risk. Gambling problem? Call 1-800-GAMBLER. 21+.',
    postalAddress,
    `Unsubscribe: ${unsubscribeLink}`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0a0a0a;font-family:Arial,sans-serif;color:#e5e5e5">
<div style="max-width:520px;margin:0 auto">
  <p style="margin:0 0 8px;font-size:13px;color:#a3a3a3">Today's free pick from ${escapeHtml(pick.author)}</p>
  <p style="margin:0 0 4px;font-size:22px;font-weight:bold;color:#ffffff">${escapeHtml(pick.pick_text)}</p>
  <p style="margin:0 0 24px;font-size:14px;color:#a3a3a3">${escapeHtml(pick.game)}${escapeHtml(when)}</p>
  <a href="${escapeHtml(picksLink)}" style="display:inline-block;padding:12px 20px;background:#c6971f;color:#171717;font-weight:bold;text-decoration:none;border-radius:6px">See today's picks</a>
  <p style="margin:32px 0 0;font-size:11px;line-height:1.5;color:#737373">
    For entertainment only. Betting involves risk. Gambling problem? Call 1-800-GAMBLER. 21+.<br>
    ${escapeHtml(postalAddress)}<br>
    <a href="${escapeHtml(unsubscribeLink)}" style="color:#737373">Unsubscribe</a>
  </p>
</div></body></html>`;

  return { subject, text, html };
}

// compose(unsubscribeLink, postalAddress) -> { subject, text, html }, so every list email
// gets its recipient's own signed unsubscribe link and the one-click headers.
async function buildMessage(env, email, compose) {
  const link = await unsubscribeUrl(env, email);
  const { subject, text, html } = compose(link, env.EMAIL_POSTAL_ADDRESS);
  return {
    from: env.EMAIL_FROM,
    to: [email],
    subject,
    text,
    html,
    headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

const pickComposer = (env, pick) => (unsubscribeLink, postalAddress) =>
  composeDailyEmail(pick, { siteUrl: env.PUBLIC_SITE_URL, unsubscribeLink, postalAddress });

// Sends one composed email to everyone subscribed, in Resend-sized batches. Callers own
// their idempotency claim; this only reports what went out.
export async function sendToList(env, compose) {
  const { results } = await env.DB.prepare(
    `SELECT email FROM email_signups WHERE email NOT IN (SELECT email FROM email_unsubscribes)`
  ).all();
  const emails = results.map((r) => r.email);
  if (emails.length === 0) return { recipients: 0, delivered: 0, errors: [] };

  const messages = await Promise.all(emails.map((email) => buildMessage(env, email, compose)));
  let delivered = 0;
  const errors = [];
  for (let i = 0; i < messages.length; i += RESEND_BATCH_LIMIT) {
    const batch = messages.slice(i, i + RESEND_BATCH_LIMIT);
    const res = await fetch(RESEND_BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (res.ok) {
      delivered += batch.length;
      await logUsage(env, 'email', batch.length);
    } else errors.push(`${res.status} ${await res.text()}`);
  }
  return { recipients: emails.length, delivered, errors };
}

// One real email to one address, outside the once-a-day guard and the list -- so the
// owner can check Resend setup and how the email renders before the list ever gets one.
export async function sendTestEmail(env, to, pick) {
  const missing = missingEmailConfig(env);
  if (missing.length > 0) return { sent: false, reason: `not configured: ${missing.join(', ')}` };
  const message = await buildMessage(env, to, typeof pick === 'function' ? pick : pickComposer(env, pick));
  message.subject = `[TEST] ${message.subject}`;
  const res = await fetch(RESEND_BATCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([message]),
  });
  if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${await res.text()}` };
  await logUsage(env, 'email');
  return { sent: true, to };
}

// Never throws -- called right after a slot's tweet posts, where a failed email must
// not look like a failed post. Returns a summary object like postSlot does.
export async function sendDailyEmail(env, pick) {
  if (env.EMAIL_PAUSED === 'true') return { sent: false, reason: 'EMAIL_PAUSED is set' };
  const missing = missingEmailConfig(env);
  if (missing.length > 0) return { sent: false, reason: `not configured: ${missing.join(', ')}` };
  if (!pick) return { sent: false, reason: 'no pick' };

  try {
    // Claim the day first so a concurrent slot or cron redelivery can't double-send.
    const claim = await env.DB.prepare(`INSERT OR IGNORE INTO daily_emails (date) VALUES (date('now', '-4 hours'))`).run();
    if (claim.meta.changes === 0) return { sent: false, reason: 'already sent today' };

    const { recipients, delivered, errors } = await sendToList(env, pickComposer(env, pick));
    if (recipients === 0) {
      await env.DB.prepare(`UPDATE daily_emails SET recipients = 0 WHERE date = date('now', '-4 hours')`).run();
      return { sent: true, recipients: 0 };
    }

    if (delivered === 0) {
      // Nothing went out: release the claim so the day's next slot can retry.
      await env.DB.prepare(`DELETE FROM daily_emails WHERE date = date('now', '-4 hours')`).run();
      return { sent: false, reason: `Resend rejected every batch: ${errors.join('; ')}` };
    }
    await env.DB.prepare(`UPDATE daily_emails SET recipients = ? WHERE date = date('now', '-4 hours')`)
      .bind(delivered)
      .run();
    return { sent: true, recipients: delivered, ...(errors.length > 0 && { errors }) };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
