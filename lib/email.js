// Welcome email via Resend. Degrades gracefully: without RESEND_API_KEY the
// member still has access the moment they're added — the email is a courtesy.

// PNG, self-hosted on the wiki: webp renders as a broken icon in several
// mail clients, and the wiki's own domain is the right provenance anyway.
const CRAB_IMG = 'https://wiki.cornellphysicalintelligence.com/welcome-crab.png';

export async function sendWelcome({ to, addedByName, host }) {
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const from = process.env.RESEND_FROM || 'CUPI Wiki <onboarding@resend.dev>';
  const url = `https://${host}`;
  const html = `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:0 4px;color:#141414;background:#ffffff">
    <div style="font-size:34px;font-weight:700;font-family:Georgia,serif;margin:28px 0 4px">CUPI</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:18px">Cornell University Physical Intelligence — Internal Wiki</div>
    <img src="${CRAB_IMG}" alt="The CUPI crab, on a beach" width="320" style="display:block;max-width:100%;height:auto;margin:4px 0 18px">
    <p>Hi,</p>
    <p><b>${addedByName}</b> added you to the CUPI wiki — the team's internal knowledge base for CAD, electronics, software, and everything in between.</p>
    <p style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600">Open the wiki</a></p>
    <p style="color:#777;font-size:13px">Sign in with your ${to} Google account — you're already on the list. If you weren't expecting this, ignore it.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject: "You're on the CUPI wiki", html }),
    });
    if (!r.ok) return { sent: false, reason: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
