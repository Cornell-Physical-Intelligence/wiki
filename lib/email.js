// Welcome email via Resend. Degrades gracefully: without RESEND_API_KEY the
// member still has access the moment they're added — the email is a courtesy.

// PNG, self-hosted on the wiki: webp renders as a broken icon in several
// mail clients, and the wiki's own domain is the right provenance anyway.
const CRAB_IMG = 'https://wiki.cornellphysicalintelligence.com/welcome-crab.png';

// The From address decides deliverability. Resolution order: an explicit
// RESEND_FROM, else wiki@ on whichever domain is verified in the Resend
// account (fetched once per instance), else Resend's shared test sender,
// which only ever delivers to the account owner.
let FROM_CACHE = null;
async function resolveFrom(apiKey, settings) {
  if (settings?.from) return `${settings.name || 'CUPI Wiki'} <${settings.from}>`;
  if (process.env.RESEND_FROM) return process.env.RESEND_FROM;
  if (FROM_CACHE) return FROM_CACHE;
  try {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const d = await r.json();
      const verified = (d.data || []).find((x) => x.status === 'verified');
      if (verified) {
        FROM_CACHE = `CUPI Wiki <wiki@${verified.name}>`;
        return FROM_CACHE;
      }
    }
  } catch (e) { /* sending-only keys cannot list domains; fall through */ }
  FROM_CACHE = 'CUPI Wiki <onboarding@resend.dev>';
  return FROM_CACHE;
}

// Refresh tokens rotate on every use; the caller persists the new pair.
export async function freshOauthToken(oauth, clientId, save) {
  if (oauth.access && oauth.accessExp > Date.now() + 30000) return oauth.access;
  const r = await fetch('https://api.resend.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: oauth.refresh }),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const t = await r.json();
  const next = {
    refresh: t.refresh_token || oauth.refresh,
    access: t.access_token,
    accessExp: Date.now() + (Number(t.expires_in) || 900) * 1000,
  };
  await save?.(next);
  return next.access;
}

export async function sendWelcome({ to, addedByName, host, settings, clientId, saveOauth }) {
  let apiKey;
  if (settings?.oauth?.refresh && clientId) {
    try { apiKey = await freshOauthToken(settings.oauth, clientId, saveOauth); }
    catch (e) { return { sent: false, reason: 'the Resend connection expired. Reconnect under Members & access → Email' }; }
  } else {
    apiKey = settings?.key || process.env.RESEND_API_KEY;
  }
  if (!apiKey) return { sent: false, reason: 'no Resend connection yet. An admin can connect one under Members & access → Email' };
  const from = await resolveFrom(apiKey, settings);
  const url = `https://${host}`;
  const html = `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:0 4px;color:#141414;background:#ffffff">
    <div style="font-size:34px;font-weight:700;font-family:Georgia,serif;margin:28px 0 4px">CUPI</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:18px">Cornell Physical Intelligence &middot; Internal Wiki</div>
    <img src="${CRAB_IMG}" alt="The CUPI crab, on a beach" width="320" style="display:block;max-width:100%;height:auto;margin:4px 0 18px">
    <p>Hi,</p>
    <p><b>${addedByName}</b> added you to the CUPI wiki, the team's internal knowledge base for CAD, electronics, software, and everything in between.</p>
    <p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Open the wiki</a></p>
    <p style="color:#777;font-size:13px">Sign in with your ${to} Google account. You're already on the list. If you weren't expecting this, ignore it.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject: "You're on the CUPI wiki", html }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      // Resend's shared test sender only delivers to the account owner's own
      // address. Say what that means for us, not what it means for Resend.
      if (/testing emails|verify a domain|not verified/i.test(detail)) {
        return { sent: false, reason: `the From address (${from}) is not on a verified Resend domain. Verify the domain in Resend, or set RESEND_FROM to an address on it and redeploy` };
      }
      return { sent: false, reason: `Resend ${r.status}: ${detail.slice(0, 160)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
