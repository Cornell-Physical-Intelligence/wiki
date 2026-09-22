# Recruitment repairs — September 22, 2026

All 16 findings in the recruitment assessment have been addressed in the wiki and club website working trees. The changes preserve the modular architecture: five server modules behind the registry, arbitrary cycle forms described by `sections.js`, the website rendering the public feed, and one shared review per person per cycle. No production data, migrations, email sends, commits, or deployments were performed.

Scope: recruitment server routes, access control, durable intake/recovery, form configuration and validation, review UI, responsive layouts, website form rendering and drafts, exports, and migration/rollback tooling. This is not an audit of unrelated wiki or website features.

Original evidence: [assessment](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/assessment.md). Its findings, old screenshots, and failure probes describe the state before these repairs; they are retained for comparison.

## Correctness and access control

| Finding | Before | After |
| --- | --- | --- |
| 1. Recovery destination | Queued forms passed through the interest-only bridge and could land in the wrong form. | Modern receipts preserve their cycle and form through automatic replay and manual placement. The legacy adapter handles old receipts. A missing destination form produces an actionable failure rather than silently changing destinations. |
| 2. Attachments | Only the first attachment survived; the question association became `file`. | Every attachment carries its question key through validation, journaling, queue downloads, replay, database storage, replacement, and rendering. Modern confirmed replacements replace the full answer/file set; legacy receipts retain their historical merge semantics. PostgreSQL file writes share the admission transaction. |
| 3. File authorization | A cycle grant could expose files from responses outside a reviewer's scope. | Downloads check the owning response against the same cycle grant and response scope. Unauthorized files return 404. Multi-select subteams participate in scope checks. |
| 4. Cross-cycle disclosure | The global applicant endpoint and history links could reveal inaccessible cycles. | Each response and history link is filtered by that cycle's grant and scope. Global identity summaries are derived from visible responses. |
| 12. Capacity | Count and insert were separate; concurrent requests could overfill a form, while legitimate replacements were rejected. | PostgreSQL admission locks the cycle row and checks capacity in the same transaction as the write. Existing applicants may confirm replacement while full. Form removal uses the same lock. The public feed exposes `full` and `available`; erased responses do not consume capacity. |

Relevant implementation: [applications.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/modules/applications.js), [kit.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/kit.js), [permissions.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/permissions.js), [intake-journal.js](/Users/andreboufama/Documents/CUPI/wiki/lib/intake-journal.js), [db.js](/Users/andreboufama/Documents/CUPI/wiki/lib/db.js).

The upload policy is explicit: 2.5 MB of attachment bytes in aggregate, bounded answer JSON, and a 4 MB request envelope accommodating base64 encoding. Errors are surfaced before a successful submission is reported. Files already lost by the previous implementation cannot be recreated by these source changes; no historical production recovery was attempted.

## Form configuration and the club website

| Finding or remnant | Before | After |
| --- | --- | --- |
| 8. People route collision | A form key `people` collided with the built-in People panel. | New forms cannot claim the reserved navigation key. Existing forms with that key use a namespaced internal route and remain editable. |
| 9. Type and required validation | Year and Subteam bypassed generic validation or used legacy types. | The declared question type and required setting govern validation, including text and multi-select answers. Reporting columns are derived afterward. Reviewer edits follow the same schema. |
| 10. Saved options | Saved Subteam options were overwritten with cycle defaults. | Saved form options are authoritative. Only unsaved default forms derive initial options from cycle settings. |
| 11. Year filters | Filters always used Freshman through Grad. | Filters use declared options and historical answer values; multi-select year/subteam values can be matched. |
| 13. Draft loss and mixing | Browser drafts clipped answers at 2,000 characters and reused the same key across cycles. | Drafts preserve supported strings up to 20,000 characters and use cycle/form identity. File reminders support maximum-length question keys. Old unscoped drafts are retained in storage but are not automatically applied to another cycle. |
| 14. Removing the landing form | Removing an empty landing form failed validation. | Removal clears its landing selection atomically; normal landing fallback then applies. A form with responses still cannot be removed. |
| Locked legacy questions | An old Interest form kept six questions fixed. | Only Name and Email remain required identity fields. Other questions can be changed or removed. The old POST adapter independently checks whether it can serve its legacy contract. |
| Website copy inferred from keys | Stock form keys/titles selected submit and success wording. | Default wording lives in form definitions; each form exposes editable submit/success labels. The website reads these values. |
| Implicit project/file grouping | Adjacent keys `project` and `file` were treated as a special combined field. | Combined text/upload questions use the explicit `longfile` type; ordinary questions render independently. |
| Duplicate availability switch | `APPLY_ACTIVE` could disagree with the public feed. | `/apply` and direct form pages use the same feed-driven availability. Existing form URLs and dynamic routing are preserved. |
| Hidden answers | The person renderer suppressed keys such as `file`, Year and Subteam regardless of their type. | Answers render using their question definitions. Attachments show their question labels. Identity fields remain in the person header. |

Relevant implementation: [sections.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/sections.js), [fixed-form.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/fixed-form.js), [site.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/modules/site.js), [ApplyOpen.jsx](/Users/andreboufama/Documents/CUPI/Website-CUPI/src/pages/ApplyOpen.jsx), [Apply.jsx](/Users/andreboufama/Documents/CUPI/Website-CUPI/src/pages/Apply.jsx), [interestDraft.js](/Users/andreboufama/Documents/CUPI/Website-CUPI/src/interestDraft.js).

The website's generated `docs/` output was rebuilt with the source changes. Its other generated route files change because they reference the new shared bundle hashes. Source assets, fonts, logo conventions, and unrelated page content remain intact.

## Review workflow and synchronization

| Finding | Before | After |
| --- | --- | --- |
| 6. Missing shared review context | Form response lists omitted flags and comment counts. | Both People and every response list show the person's shared flag and comment count, with matching review filters. Mutations still write to `recruit_people`, never a new submission-level thread. |
| 7. Stale lists | Background synchronization refreshed counts while cached lists stayed stale. | People and response modules register refresh hooks, preserve the loaded list extent, and expose manual refresh. Cycle/form definitions reconcile when the editor is clean. Dirty edits and comment drafts survive background updates; form saves retain the version originally loaded to detect conflicts. |
| 15. Inconsistent CSV review state | People displayed legacy review fallback, but its CSV exported empty reviews. | Lists and People CSV use one shared review projection, including legacy fallback until a person review is materialized. |
| 16. Silent truncation | People stopped at 2,000 and PostgreSQL grouping began from at most 10,000 responses; search was limited to loaded rows. | Those caps are removed. People search/filtering happens on the server, the browser pages with a stable time/email cursor, totals include the full result, and CSV output is streamed without the old row caps. |

Relevant implementation: [people.js](/Users/andreboufama/Documents/CUPI/wiki/lib/recruit/modules/people.js), [recruit-applications.js](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit-applications.js), [recruit-people.js](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit-people.js), [recruit-core.js](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit-core.js).

Scale boundary: pagination is applied to server-grouped people, and CSV bytes stream with backpressure, but grouping still loads the cycle's response summaries into server memory. This removes silent data loss and avoids sending all people to the browser; it is not database-level grouped pagination or a constant-memory export pipeline. The volume regression covers 2,011 synthetic people, not a production-scale load test.

## Interface changes

### Review visibility and responsive layout

| Before | After |
| --- | --- |
| Finding 5: a 960px table inside a 352px phone container; review controls began around x=875. | Compact mobile rows fit the 352px container at a 390px viewport, with review controls visible on-screen. `recruit.css` removes the forced minimum at narrow widths. |
| Review actions sat at the far edge of People and were missing in Responses. | A dedicated Review column sits beside identity on desktop; compact layouts retain identity, review, and selection. |
| Tablet column widths squeezed names to almost nothing. | A 900px container breakpoint switches to compact rows; verified at a 768px viewport with a 730px table/container. |
| More forms produced more date columns. | Desktop People uses a compact participation column; narrow rows show form chips below identity. |
| Desktop response rows devoted space to names without useful answer context. | Deliberate widths and a two-line excerpt from a suitable configured answer make the response list more useful to scan. |
| Year, subteam, and date disappeared when desktop columns were hidden. | Compact rows retain these values under the person's identity. |
| Names and addresses could be clipped on phones. | Identity text wraps, and review controls remain in a fixed visible column. |
| Narrow toolbars and website addresses competed for space. | Search/actions wrap, filters can share the available width, and the website address can wrap. |
| Many forms stretched tabs and person-dialog segments. | Larger form sets use the existing custom dropdown pattern in cycle navigation and the person dialog. |
| Comments appeared after long answers, and focusing before data loaded could leave the composer off-screen. | The comment control opens the shared discussion and scrolls/focuses it after details load. |
| Delete confirmation claimed comments would be removed. | Copy explicitly reflects submission deletion and retained shared person review. |
| Review/filter changes and background updates were difficult to observe. | Shared flags/counts repaint across active lists; explicit Refresh is available. |

### Editing clarity and touch targets

| Before | After |
| --- | --- |
| Placeholder editors resembled applicant input controls. | A distinct edit state and a separate read-only preview make their purposes clear. |
| Form settings were below the entire question list. | A compact settings disclosure sits near the form header. |
| Submit and success labels were inaccessible in the editor. | Form settings expose both labels and publish them through the public feed. |
| Required identity toggles implied Name/Email could become optional. | Their required controls are disabled and server validation enforces the identity contract. |
| Small or hover-only controls were difficult to use on phones. | Review buttons, drag grips, option tools, and relevant editor controls receive 40–44px targets; touch devices keep actions visible. |
| Selection columns could clip the checkbox or its hit area. | A 44px selection column with 2px side padding contains the full 40px control. |
| Form actions could crowd the phone footer. | Save/Discard controls wrap with safe-area spacing. |

Relevant implementation: [recruit.css](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit.css), [recruit-forms.js](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit-forms.js), [recruit-cycles.js](/Users/andreboufama/Documents/CUPI/wiki/src/client/recruit-cycles.js). The existing wiki shell, brand assets, custom menu keyboard behavior, and person navigation are retained.

Final captures: [People mobile](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-people-mobile.png), [People desktop](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-people-desktop.png), [Responses mobile](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-responses-mobile.png), [Responses tablet](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-responses-tablet.png), [Responses desktop](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-responses-desktop.png), [Editor mobile](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-editor-mobile.png), [Preview mobile](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-preview-mobile.png), [Comments mobile](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-person-mobile.png), [Website submission](/Users/andreboufama/Documents/CUPI/wiki/output/recruit-review-2026-09-22/fixed-website-submission-mobile.png).

## Compatibility, retained data, and recovery

| Before | After |
| --- | --- |
| Rollback could be mistaken for a complete modern restore. | The CLI calls it a legacy projection and requires a new backup path before writing. |
| Legacy projection used only submission-level reviews. | It uses current shared person reviews when available. |
| No mandatory snapshot before projecting into the old email-unique, single-file table. | A repeatable-read snapshot captures the cycle, settings, responses, applicant identities, person reviews, grants, audit, referenced receipt outcomes, and referenced attachment bytes. The new file is owner-only and cannot overwrite an existing backup. |
| Old UI helpers and defaults obscured the modern contract. | Removed the fixed client year vocabulary, dead fixed-choice/person-cell helpers, obsolete table/date styles, website key-based rendering/copy, and duplicate availability constant. |

[recruit-backup.mjs](/Users/andreboufama/Documents/CUPI/wiki/scripts/recruit-backup.mjs) and [recruit-rollback.mjs](/Users/andreboufama/Documents/CUPI/wiki/scripts/recruit-rollback.mjs) do not delete modern recruitment tables or the receipt journal. The snapshot is a cycle-content safeguard, not a full deployment backup: the separate Blob journal, global request-idempotency cache, unrelated cycles, and any inactive extension tables still belong in infrastructure backups. No automated snapshot restore command is introduced.

The following remnants are deliberately retained because they have compatibility or persisted-data consumers:

- `lib/interest.js`, the old POST bridge, fixed legacy vocabulary, and migration converters support stale clients and historical imports. The modern website no longer chooses that endpoint.
- The three stock website URLs remain valid; dynamic forms continue through the existing redirect/router mechanism.
- Stage/history, decisions, tags, and form-version fields remain in stored responses and are used by kernel APIs, migration, and regression tests. Removing them would change the storage/API contract.
- Score/assignment joins are guarded by the registry's enabled-table set. No score/assignment panel or module is mounted among the five current modules. Their dormant extension hooks are not used to define the public form contract.
- Legacy interest tables and original file data remain available for recovery. Source cleanup does not drop their data.

## Verification

All verification used synthetic data and isolated local services.

| Check | Result |
| --- | --- |
| Wiki `npm run test:recruit` | Passed all five suites, including new regression cases. |
| Wiki `node --test scripts/test-recruit-contract.mjs` | Passed all three module/registry contract checks. |
| Disposable PostgreSQL integration | Passed eight concurrent admissions against capacity one: one saved, seven held. Also verified replacement while full, idempotent retry, transactional attachments, removing old attachments on replacement, failed form-removal rollback, real list/grouping SQL, active capacity counts, snapshot file bytes, and overwrite refusal. |
| Large synthetic cycle | 2,011 people; pagination with no overlap, a late-record server search, and complete CSV export passed. |
| Website draft tests | Passed length preservation, cycle isolation, maximum-length attachment reminder keys, and existing form behavior. |
| Wiki `npm run check` | Build, preview build, and SEO checks passed in both the working tree and isolated preview copy. Tracked `docs/index.html` and `dist/artifact.html` were regenerated. |
| Website `npm run check` | Lint/build and production asset, font, and SEO checks passed; 12 production routes verified. |
| Browser | Chromium at 390px, 768px, and 1440px; People, Responses, editor/preview, and shared comments inspected. No browser errors reported. |
| Website-to-wiki flow | Submitted an added custom form with short-text Year, multi-select Subteam, a roughly 5,400-character draft restored after reload, and two distinct PDF questions. Confirmed the saved response retained both selected teams, the full trimmed answer, and both question-associated files. |
| Whitespace validation | `git diff --check` passed in both repositories. |

Reproducible additions: [regression cases](/Users/andreboufama/Documents/CUPI/wiki/scripts/recruit-regression-cases.mjs), [real PostgreSQL test](/Users/andreboufama/Documents/CUPI/wiki/scripts/test-recruit-postgres-live.mjs). Run the latter with `RECRUIT_PG_RUNTIME` pointing to an isolated installation of `embedded-postgres` and `pg`; it creates and removes its own temporary cluster and never reads configured production database credentials.

Limits: responsive Chromium testing does not replace physical iOS/Android verification. These repairs prevent the reproduced failures going forward; they do not establish whether production applicants previously lost files or experienced cross-cycle disclosure. No production data investigation was performed.
