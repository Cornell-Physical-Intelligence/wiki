// One sender for every email the wiki writes. Resolves the Resend credential
// (OAuth refresh, else the saved key, else the environment), picks the From
// address, posts to Resend, and maps a refused From into a reason members can
// act on. Never throws: a message the wiki cannot send is a reason, not a
// failed request. sendWelcome and the recruitment mailer both build their
// HTML and hand it here.

import { freshOauthToken, resolveFrom } from './email.js';

export async function sendEmail({ to, subject, html, text, replyTo, settings, clientId, saveOauth }) {
  let apiKey;
  if (settings?.oauth?.refresh && clientId) {
    try { apiKey = await freshOauthToken(settings.oauth, clientId, saveOauth); }
    catch (e) { return { sent: false, reason: 'the Resend connection expired. Reconnect under Integrations → Email' }; }
  } else {
    apiKey = settings?.key || process.env.RESEND_API_KEY;
  }
  if (!apiKey) return { sent: false, reason: 'no Resend connection yet. An admin can connect one under Integrations → Email' };
  let from;
  try { from = await resolveFrom(apiKey, settings); }
  catch (e) { return { sent: false, reason: e.message }; }
  // Key order matters: sendWelcome's request body must stay byte-identical
  // to what it sent before it delegated here.
  const payload = { from, to, subject, html };
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      // Resend's shared test sender only delivers to the account owner's own
      // address. Say what that means for us, not what it means for Resend.
      if (/testing emails|verify a domain|not verified|not authorized to send emails from/i.test(detail)) {
        return { sent: false, reason: `Resend refuses the From address (${from}). Pick an address on a verified domain under Integrations → Email` };
      }
      return { sent: false, reason: `Resend ${r.status}: ${detail.slice(0, 160)}` };
    }
    let id = '';
    try { id = (await r.json())?.id || ''; } catch (e) { /* an empty body is still a send */ }
    return { sent: true, id };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
