# CUPI Wiki

Internal knowledge base for Cornell Physical Intelligence (CUPI), a Cornell University student robotics organization — built for how a hardware team documents things. Live at **[wiki.cornellphysicalintelligence.com](https://wiki.cornellphysicalintelligence.com)**; the main site is [cornellphysicalintelligence.com](https://cornellphysicalintelligence.com).

- Markdown pages with `[[wiki links]]`, backlinks, callouts, live task checklists, tables (sortable), code blocks
- Drag-and-drop **images, schematics, and CAD**: STL/OBJ get an interactive 3D viewer in the page; STEP / SchDoc / PcbDoc / PDF attach as labeled cards; **Onshape and Altium 365 links become rich cards**
- Full **version history with diffs and restore**, trash with 30-day retention
- **⌘K search**, templates (meeting notes, design doc, decision record, BOM, test report, bring-up log)
- Comments, activity feed, per-page **watching with an inbox**, starred pages, **wiki health** (broken links / orphans / stale pages)
- **Google OAuth restricted to cornell.edu** + an admin-managed member allowlist with emailed invite codes
- Matches the design language of [cornellphysicalintelligence.com](https://cornellphysicalintelligence.com)

## Architecture

No framework. The client is one self-contained HTML file (`scripts/build.mjs` assembles it from `src/client/`). The backend is one Vercel serverless function (`api/index.js`): OAuth, HMAC-signed session cookies, a versioned JSONB state document in Postgres with optimistic-concurrency writes, and attachments as `bytea` rows. Clients apply mutations optimistically and the server re-validates every one against the member's role.

### Storage and synchronization

- `wiki_state` holds shared content and revision history. A version-matched compressed snapshot reduces database transfer; canonical JSONB remains available for cache repair.
- `wiki_user_prefs` holds each member's stars, recent pages, watches, and display settings with a separate version. Saving preferences neither rewrites shared content nor forces other members to download it. Reads and writes return only the signed-in member's preferences; writes check active membership in the same database statement.
- Existing preferences remain in the legacy state as a fallback until that member first saves. The first save copies and merges them into the new table. Include **both tables** in backups. A backend rollback must retain the new table and its read overlay, or newer personal settings will temporarily be hidden.
- `/api/state?since=<content version>&prefsSince=<personal version>` checks both versions in one small query. A preferences-only change returns preferences without pages or attachment listings. Older open tabs can still save; reload them to receive cross-device preference changes without waiting for a content change.
- Hidden tabs and tabs idle for five minutes pause polling. Preference saves are debounced and duplicate values are skipped. Server acknowledgments include the canonical saved values so validation limits cannot leave the client displaying unsaved settings.
- Multipart page uploads retain their parts until the completed file is verified. A stable file ID makes finish retries reuse the same file after a lost response; cleanup failures do not invalidate a successful upload.

The public Interest form uses a separate private Blob receipt journal before database processing. Its recovery path and browser draft protections are independent of wiki preference synchronization.

## Deploy (≈10 minutes, one time)

1. **Import to Vercel** — vercel.com → *Add New → Project* → import `Cornell-Physical-Intelligence/wiki`. The defaults work (`vercel.json` carries the build command).
2. **Add Postgres** — in the Vercel project: *Storage → Create Database → Postgres (Neon)*. This injects `POSTGRES_URL` automatically. Tables and the seed state create themselves on first request.
3. **Google OAuth** — [console.cloud.google.com](https://console.cloud.google.com) → *APIs & Services → Credentials → Create OAuth client ID* (Web application):
   - Authorized redirect URIs: `https://wiki.cornellphysicalintelligence.com/api/auth/callback` **and** `https://<project>.vercel.app/api/auth/callback`
   - Put **Client ID / Client secret** into Vercel env vars `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - Also set `SESSION_SECRET` to a long random string (`openssl rand -hex 32`)
4. **Domain** — Vercel project → *Settings → Domains* → add `wiki.cornellphysicalintelligence.com`; then in Google Cloud DNS (the domain's DNS host) add: `wiki  CNAME  cname.vercel-dns.com.`
5. **Invite emails (optional)** — create a [Resend](https://resend.com) key, set `RESEND_API_KEY` (and `RESEND_FROM` once the domain is verified there). Without it, invites still work — admins share the code from the Pending list.

First sign-in: `ab3233@cornell.edu` is seeded as admin. Add everyone else from **Members & access**.

## Local dev

```bash
npm run dev     # builds the client and serves on :4870 with fake auth + in-memory DB
```

## Security model

Google proves the email (domain re-verified server-side — the `hd` hint is not trusted); the allowlist in state decides membership; every mutation is re-applied server-side with role checks; invite codes are one-time, admin-visible only; sessions are HMAC-signed HttpOnly cookies. Attachments are served only to signed-in members.
