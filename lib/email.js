// Invite email via Resend. Degrades gracefully: without RESEND_API_KEY the
// invite is still created and the admin UI shows the code to share manually.

export async function sendInvite({ to, code, invitedByName, host }) {
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const from = process.env.RESEND_FROM || 'CUPI Wiki <onboarding@resend.dev>';
  const url = `https://${host}`;
  const html = `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;color:#141414">
    <div style="font-size:34px;font-weight:700;font-family:Georgia,serif;margin:28px 0 4px">CUPI</div>
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:24px">Cornell University Physical Intelligence — Internal Wiki</div>
    <p>Hi,</p>
    <p><b>${invitedByName}</b> added you to the CUPI wiki — the team's internal knowledge base for CAD, electronics, software, and everything in between.</p>
    <p>Sign in at <a href="${url}" style="color:#141414"><b>${host}</b></a> with this Google account, or enter your invite code:</p>
    <div style="margin:18px 0;padding:14px;border:1px dashed #999;border-radius:6px;text-align:center;font-family:'Courier New',monospace;font-size:20px;letter-spacing:.12em">${code}</div>
    <p style="color:#777;font-size:13px">The code is one-time and tied to ${to}. If you weren't expecting this, ignore it.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject: "You're invited to the CUPI wiki", html }),
    });
    if (!r.ok) return { sent: false, reason: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
