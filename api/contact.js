const { Resend } = require('resend');

const TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'jqoboyle@gmail.com';
// Falls back to Resend's shared sandbox sender, which works with no domain
// verification. Once a custom domain is verified in Resend, set
// RESEND_FROM_EMAIL (e.g. "Jax Media Co <notifications@jaxmediaco.com>")
// as a Vercel env var — no code change or redeploy needed.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Jax Media Co Website <onboarding@resend.dev>';

// Best-effort in-memory guards. These reset on cold start and are per-instance
// only (no shared store), so they're a supplement to client-side debouncing
// and the honeypot field, not a substitute for a real rate limiter.
const recentSubmissions = new Map(); // key -> timestamp
const ipHits = new Map(); // ip -> [timestamps]
const DEDUPE_WINDOW_MS = 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 8;

function cleanupMaps() {
  const now = Date.now();
  for (const [k, t] of recentSubmissions) if (now - t > DEDUPE_WINDOW_MS) recentSubmissions.delete(k);
  for (const [ip, hits] of ipHits) {
    const kept = hits.filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length) ipHits.set(ip, kept); else ipHits.delete(ip);
  }
}

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > RATE_MAX;
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { name, phone, email, business, service, message, hp_field } = body;

  // Honeypot: bots fill hidden fields. Pretend success, do nothing.
  if (hp_field) {
    return res.status(200).json({ ok: true });
  }

  const cleanName = (name || '').toString().trim().slice(0, 200);
  const cleanPhone = (phone || '').toString().trim().slice(0, 60);
  const cleanEmail = (email || '').toString().trim().slice(0, 200);
  const cleanBusiness = (business || '').toString().trim().slice(0, 200);
  const cleanService = (service || '').toString().trim().slice(0, 200);
  const cleanMessage = (message || '').toString().trim().slice(0, 5000);

  if (!cleanName || !cleanMessage || (!cleanEmail && !cleanPhone)) {
    return res.status(400).json({ ok: false, error: 'Missing required fields: name, message, and a phone or email are required.' });
  }
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ ok: false, error: 'Invalid email address.' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').toString().split(',')[0].trim();
  cleanupMaps();

  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions. Please try again later.' });
  }

  const dedupeKey = [cleanName, cleanPhone, cleanEmail, cleanMessage].join('|');
  const lastSeen = recentSubmissions.get(dedupeKey);
  if (lastSeen && Date.now() - lastSeen < DEDUPE_WINDOW_MS) {
    // Same submission arrived again within the window (retry/double-click). Treat as success, don't resend.
    return res.status(200).json({ ok: true, duplicate: true });
  }
  recentSubmissions.set(dedupeKey, Date.now());

  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'Email service is not configured.' });
  }

  const submittedAt = new Date();
  const dateStr = submittedAt.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';

  const rows = [
    ['Name', cleanName],
    ['Phone', cleanPhone || '—'],
    ['Email', cleanEmail || '—'],
    ['Business Name', cleanBusiness || '—'],
    ['Service Interested In', cleanService || '—'],
    ['Message', cleanMessage],
    ['Submitted', dateStr],
    ['IP', ip],
  ];

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
      <h2 style="margin:0 0 16px">New lead from jaxmediaco.com</h2>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        ${rows.map(([label, value]) => `
          <tr>
            <td style="font-weight:bold;vertical-align:top;padding-right:12px;white-space:nowrap">${esc(label)}</td>
            <td style="white-space:pre-wrap">${esc(value)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `.trim();

  const text = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      reply_to: cleanEmail || undefined,
      subject: `New lead: ${cleanName}${cleanService ? ' — ' + cleanService : ''}`,
      html,
      text,
    });
    if (error) {
      console.error('Resend error:', error);
      return res.status(502).json({ ok: false, error: 'Failed to send email.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form send failed:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected error sending email.' });
  }
};
