# CUPI Wiki

Internal knowledge base for Cornell Physical Intelligence (CUPI), a Cornell University student robotics organization — built for how a hardware team documents things. Live at **[wiki.cornellphysicalintelligence.com](https://wiki.cornellphysicalintelligence.com)**; the main site is [cornellphysicalintelligence.com](https://cornellphysicalintelligence.com).

- Markdown pages with `[[wiki links]]`, backlinks, callouts, live task checklists, tables (sortable), code blocks
- Drag-and-drop **images, schematics, and CAD**: STL/OBJ get an interactive 3D viewer in the page; STEP / SchDoc / PcbDoc / PDF attach as labeled cards; **Onshape and Altium 365 links become rich cards**
- Full **version history with diffs and restore**, trash with 30-day retention
- **⌘K search**, templates (meeting notes, design doc, decision record, BOM, test report, bring-up log)
- **Search** automatically searches page previews for the task you describe; save previews suggest change summaries and flag concrete dependencies in linked pages
- Admin intake review with shared flags, attributed comments, direct row deletion, and archives that preserve reviews
- Comments, activity feed, per-page **watching with an inbox**, starred pages, **wiki health** (broken links / orphans / stale pages)
- Sidebar: Home, Applications (admins), New page, then the page tree. Activity, Wiki health, Trash, Members (roster and access log), Integrations (AI and email), bug reports, and keyboard shortcuts live in the **Settings** menu behind the gear beside the account card
- **Google OAuth restricted to cornell.edu** + an admin-managed member allowlist with emailed invite codes
- Matches the design language of [cornellphysicalintelligence.com](https://cornellphysicalintelligence.com)

## Brand

The CUPI mark is four circles: left half filled, bottom half filled, upper-right quarter filled, and an outline split by a vertical bar. It is the club's logo everywhere in this repo; the crab that appears on the welcome page, in the welcome email, and on the link-preview card is a mascot illustration, not the logo.

- `src/client/logo-row.svg` — the row form, used by the boot splash (inlined into the shell at build time; draws in `currentColor` so it follows the theme). Inside the app the sidebar brand is the 2x2 mark (inlined as `CUPI_MARK`, 20px, strokes rescaled to about a pixel) followed by the text "CUPI Wiki" in the display serif (Playfair Display).
- `src/client/logo-square.svg` — the 2x2 form, the master for every icon: `favicon-squircle-32.png` (browser tab, inline data URI) and `favicon-cupi-192.png` (crawlable `/favicon-cupi.png`, Apple touch icon) are rasterized from it as a black mark on white with a hairline edge.
- Opening the wiki shows the mark drawing itself in over the page background until the store has booted, then the splash fades out over the app (`settleBoot` in `src/client/main.js`). The mark does not travel to the sidebar.

Re-rasterize the PNGs from `logo-square.svg` whenever the mark changes; do not reintroduce the crab as a logo or icon.

Signed out, the wiki shows its own frame with the members-only parts closed. The sidebar keeps the brand, the section names (no pages), and a "Not signed in" account row; there is no search box or page navigation. The content column mirrors the home page: a "Sign in to the CUPI Wiki" heading, then the Google sign-in control in the slot the search box has when signed in, then one line on what the wiki is and who can sign in (`SIGNIN_NOTE` in `src/client/ui.js`). No card, no footer. Both builds render through `viewLoginShell`; `src/remote.js` supplies the live Google link and the denied notice. Keyboard shortcuts and preference writes are off until someone signs in.

People are credited by name alone on pages, in history, in the activity feed, and in the trash; the initials bubble appears only on the signed-in account row and the preview build's account chooser. The editor always opens in split view (write-only below 900px wide); the Write / Split / Preview tabs change only the open editor. "Export wiki as Markdown" lives in the Settings menu with the other wiki tools.
## Architecture

No framework. The client is one self-contained HTML file (`scripts/build.mjs` assembles it from `src/client/`). The backend is one Vercel serverless function (`api/index.js`): OAuth, HMAC-signed session cookies, a versioned JSONB state document in Postgres with optimistic-concurrency writes, and attachments as `bytea` rows. Clients apply mutations optimistically and the server re-validates every one against the member's role.

### Storage and synchronization

- `wiki_state` holds shared content and revision history. A version-matched compressed snapshot reduces database transfer; canonical JSONB remains available for cache repair.
- `wiki_user_prefs` holds each member's stars, recent pages, watches, and display settings with a separate version. Saving preferences neither rewrites shared content nor forces other members to download it. Reads and writes return only the signed-in member's preferences; writes check active membership in the same database statement.
- Existing preferences remain in the legacy state as a fallback until that member first saves. The first save copies and merges them into the new table. Include **both tables** in backups, plus every `recruit_*` table listed under Applications. A backend rollback must retain the new table and its read overlay, or newer personal settings will temporarily be hidden.
- `/api/state?since=<content version>&prefsSince=<personal version>` checks both versions in one small query. A preferences-only change returns preferences without pages or attachment listings. Older open tabs can still save; reload them to receive cross-device preference changes without waiting for a content change.
- Hidden tabs and tabs idle for five minutes pause polling. Preference saves are debounced and duplicate values are skipped. Server acknowledgments include the canonical saved values so validation limits cannot leave the client displaying unsaved settings.
- Multipart page uploads retain their parts until the completed file is verified. A stable file ID makes finish retries reuse the same file after a lost response; cleanup failures do not invalidate a successful upload.
- `wiki_ai_usage` holds shared OpenAI spending reservations, measured token costs, and request counters separately from content. Include it in backups and retain it across redeployments and rollbacks; deleting or restoring an older ledger can reset spending protection. Production uses atomic versioned updates across workers; local development uses `.devaiusage.json`.

### Applications (recruitment)

**Applications** (`#/applications`) holds recruitment cycles. The current interest list is one cycle, named for its term when imported ("Fall 2026"), and each cycle has exactly three sections: the **interest form**, **coffee chats**, and the **application**. Every section is a form the club website renders and a list the wiki reviews, with the update-by-email semantics the interest form always had: one row per email per section, and a repeat asks before replacing.

- **Website feed.** `GET /api/recruit/site` (public, CORS-limited to the site, never cached) describes the cycle receiving the website, `landing` (the form `/apply` shows), and its sections: key, title, description, `open`, and the question list (`short`, `long`, `email`, `single`, `multi`, `checkbox`, `link`, `file`). `POST /api/recruit/site/<section>` takes `{ answers, files, website, confirmUpdate }`, validates against that section's form, journals the receipt, writes the row, and emails the team when the cycle asks for it. `POST /api/interest` is unchanged and lands in the receiving cycle's interest section. Before any cycle receives the website, the feed publishes the fixed interest form and the fixed POST goes to the legacy inbox as before.
- **Editing forms.** Each section tab has two views, Responses and Form. Form draws the questions as applicants see them: title, description, and per question the label, a note, the answer type (short text, long text, email, choose one, choose many, checkbox, link, file), the options, required, and the order; one switch opens or closes the form on the website, another marks it as the form `/apply` shows (the QR code's address; with none marked, `/apply` shows the first open form). Nothing changes until Save. The interest form keeps the website's six fixed questions (name, email, subteam, year, project, file) and can gain more; the other two only need a name and an email. The website reads the change on its next load; every form also has its own page on the site (`/apply/interest/`, `/apply/coffee/`, `/apply/application/`), which the tab bar links to.
- **Reviewing.** Each section is a tab on the cycle: search, filter by subteam and year, open a row for every answer and file, comments and flags, copy emails, delete, and a formula-safe CSV per section.
- **Cycles.** Status draft, open, closed, or archived; exactly one open cycle receives the website. Subteams, capacity, and intake limits live in the cycle's settings; who may review lives under Roles.

Server modules are plain objects (`lib/recruit/modules/{cycles,applications,roles,site}.js`) mounted by `lib/recruit/index.js` through one registry; `api/index.js` forwards `/api/recruit/*` with a single line; `lib/recruit/sections.js` owns the section defaults, the public shape, and validation of edits. Client modules (`src/client/recruit-{core,cycles,forms,applications}.js`) call `RECRUIT.register` and are concatenated after `ai.js`; `recruit-forms.js` is the form editor. Tables (`recruit_cycles`, `recruit_settings`, `recruit_applications`, `recruit_applicants`, `recruit_roles`, `recruit_audit`, `recruit_requests`, `interest_receipts`) are created lazily with additive statements only, writes that must be atomic are single SQL statements, and every storage function has a memory branch (`.devrecruit.json`, gitignored) so `npm run dev` runs the whole feature. Tests: `npm run test:recruit` and `node --test scripts/test-recruit-contract.mjs`. The club website's Apply page (`src/pages/ApplyOpen.jsx` in the `General-Website` repo) renders the feed; its fallback copy of the interest form lives in `src/data/applyForms.js` there and must match `lib/recruit/sections.js`.

**Migration.** The current list and its archives are imported from the cycle index (admin, "Import the current list and archives"); the import is copy-only, idempotent, and resumable, and `interest_submissions` / `interest_archives` are left in place. `scripts/recruit-rollback.mjs --cycle cy-… [--dry-run]` reverses a cycle. Until the import runs, everything behaves as before.

**Backups** must include every `recruit_*` table above. Submissions pass through a separate private Blob receipt journal before database processing; its recovery path and browser draft protections are independent of wiki preference synchronization.

## Deploy (≈10 minutes, one time)

1. **Import to Vercel** — vercel.com → *Add New → Project* → import `Cornell-Physical-Intelligence/wiki`. The defaults work (`vercel.json` carries the build command).
2. **Add Postgres** — in the Vercel project: *Storage → Create Database → Postgres (Neon)*. This injects `POSTGRES_URL` automatically. Tables and the seed state create themselves on first request.
3. **Google OAuth** — [console.cloud.google.com](https://console.cloud.google.com) → *APIs & Services → Credentials → Create OAuth client ID* (Web application):
   - Authorized redirect URIs: `https://wiki.cornellphysicalintelligence.com/api/auth/callback` **and** `https://<project>.vercel.app/api/auth/callback`
   - Put **Client ID / Client secret** into Vercel env vars `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   - Also set `SESSION_SECRET` to a long random string (`openssl rand -hex 32`)
4. **Domain** — Vercel project → *Settings → Domains* → add `wiki.cornellphysicalintelligence.com`; then in Google Cloud DNS (the domain's DNS host) add: `wiki  CNAME  cname.vercel-dns.com.`
5. **Invite emails (optional)** — create a [Resend](https://resend.com) key, set `RESEND_API_KEY` (and `RESEND_FROM` once the domain is verified there). Without it, invites still work — admins share the code from the Pending list.
6. **Page assistance (optional)** — an admin connects an OpenAI API key under **Integrations → AI**, chooses a model and reasoning effort, and tests the connection there. Defaults are Luna (`gpt-5.6-luna`) with no reasoning for speed. Keys are AES-256-GCM encrypted using `WIKI_CREDENTIAL_SECRET` (or the existing `SESSION_SECRET`); keep that server secret stable across deployments. An existing server-side `OPENAI_API_KEY` remains a migration fallback until a saved key replaces it; Disconnect disables both. Set server-side `TYPESAFE_API_KEY` separately for Jev (`jev-latest`) and redeploy. ChatGPT/Codex sign-in does not supply the Platform API credential. Never put either key in client files or public environment variables.

First sign-in: `ab3233@cornell.edu` is seeded as admin. Add everyone else from **Members**.

### Page assistance

Change summaries start quietly after a 1.6-second pause while editing, with at least 10 seconds between background requests. Exact recent drafts reuse their results, including Undo and opening Save; hidden tabs, composition, pending uploads, unchanged pages and disconnected AI skip prefetch. Failures back off for 30 seconds. Saving opens an editable summary and a bounded diff preview immediately, using a cached suggestion as the placeholder when ready; generation never disables Save. The owner-selected model (Luna by default) receives the page title, section and changed lines, with embedded file data removed; provider response storage is disabled. A basic summary remains available when the key is absent or the provider times out. After a pause in editing, Jev quietly checks the page for a clearer section, unfinished placeholders, unassigned commitments, and concrete effects on up to eight linked pages. Suggestions never change content automatically or prevent saving.

**Search** automatically sends the query and up to 32 eligible page previews (a mix of keyword matches and pages from each section) to Jev. It returns up to five strongly relevant pages ahead of normal results. Existing search filters still apply. Requests are debounced and cancelled when the query changes or search closes. Results appear in the normal list without an AI mode or status; existing keyboard selections stay in place. This is bounded discovery rather than an exhaustive semantic index. Attachments and intake records are never candidates.

All three endpoints require active membership. Requests have size limits and short timeouts, and identical provider calls share a ten-minute in-memory cache. Provider credentials stay on the server, and provider failures leave normal search and saving available. `npm run test:assistance` exercises provider contracts and save-preview behavior with synthetic transports.

**OpenAI spending:** Integrations → AI shows estimated costs and request counts for today and this month. The shared limits are **$1/day, $5/calendar month, and 5¢ per request**, with UTC boundaries. Every paid request, including connection tests, must first reserve its conservative maximum cost in Postgres. Provider-reported input, cached input, cache-write and output/reasoning usage settle that reservation; timeouts, missing usage, and failed accounting keep the full reservation counted. If accounting is unavailable, no new provider call is sent. Unexpected costs or provider tiers pause calls for review. Editing and saving remain available throughout.

OpenAI calls are additionally limited to 3 concurrent requests globally (1 per member), 30/minute globally (8 per member), and 1,200/day globally (200 per member). Cross-worker duplicates are suppressed for two minutes, and a crashed worker releases its concurrency slot after 90 seconds without refunding possible spend. High-cost model/effort combinations may be rejected by the 5¢ request ceiling. Limits cannot be raised by browser input or by replacing a key. The admin readout refreshes only while visible, without replacing unsaved forms.

Tracking starts when the ledger is initialized and covers this wiki’s OpenAI requests only. It excludes earlier use, Jev, hosting, and other applications sharing the key. Costs use published standard short-context rates dated September 18, 2026; review `lib/ai-usage.js` when provider pricing changes. The provider invoice remains authoritative. There is deliberately no UI action to clear the ledger or reset a safety halt; inspect provider billing and reconcile retained reservations before changing it. `node --test scripts/test-ai-usage.mjs scripts/test-ai-usage-ui.mjs` covers concurrent workers, budget races, crash/timeout handling, UTC rollover, and settings refresh behavior without using a real credential.

Intake review adds `review` and `review_version` columns on first use. Keep them in database backups. Comments append atomically with retry-safe IDs; applicant updates cannot overwrite review data. Archive clearing checks both the application and review versions so a comment arriving during archiving stays on the live list.

## Local dev

```bash
npm run dev     # builds the client and serves on :4870 with fake auth + in-memory DB
```

## Security model

Google proves the email (domain re-verified server-side — the `hd` hint is not trusted); the allowlist in state decides membership; every mutation is re-applied server-side with role checks; invite codes are one-time, admin-visible only; sessions are HMAC-signed HttpOnly cookies that last 30 days and renew on use (a page load or poll in the second half of a session issues a fresh cookie). When a session does end, the open tab asks the member to sign in again instead of failing quietly on the next save or AI call. Attachments are served only to signed-in members, always with `X-Content-Type-Options: nosniff`; known image, video, audio, text, and PDF types render inline (non-PDF under `Content-Security-Policy: sandbox`, so an uploaded SVG or anything else opened directly has no access to the wiki origin), and every other type downloads as `application/octet-stream`. Mutation ops are dispatched only to the module's own functions, so prototype names like `constructor` are rejected and an op error is always a plain string.

The workspace uses restrained navigation and reference-wiki article structure. Floating surfaces share a custom WebGL fragment shader for curved edge lighting and shading, with CSS backdrop blur. One shared renderer draws only on open, resize or theme change. Reduced-transparency/high-contrast preferences and unavailable WebGL use a readable fallback.
