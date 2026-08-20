/* ============================================================================
   Seed data — a lived-in knowledge base. Content is grounded in CUPI's real
   projects (Hexapod, Scout quad, Modovolo payload, AI Grand Prix, the π0.5
   arm) so the wiki reads like the team wrote it, not like a demo.
   ========================================================================== */

'use strict';

// Timestamps are offsets from load so relative dates always read fresh.
const NOW = Date.now();
const ago = (days, hours = 0) => NOW - (days * 24 + hours) * 3600 * 1000;

/* ----------------------------------------------------------------------------
   Users. Real leads from the site roster. ab3233 is real; other netids are
   preview placeholders until the roster is wired to the real allowlist.
   -------------------------------------------------------------------------- */
const SEED_USERS = [
  { email: 'ab3233@cornell.edu', name: 'Andre Boufama',      role: 'admin',  status: 'active',  subteam: 'Team Lead',   joined: ago(320) },
  { email: 'nl482@cornell.edu',  name: 'Nicholas Letendre',  role: 'admin',  status: 'active',  subteam: 'Team Co-Lead', joined: ago(320) },
  { email: 'js2801@cornell.edu', name: 'Jonathan Song',      role: 'member', status: 'active',  subteam: 'Electrical',  joined: ago(290) },
  { email: 'mr977@cornell.edu',  name: 'Mic Robbins',        role: 'member', status: 'active',  subteam: 'Electrical',  joined: ago(288) },
  { email: 'am3644@cornell.edu', name: 'Alan Munschy',       role: 'member', status: 'active',  subteam: 'Mechanical',  joined: ago(285) },
  { email: 'oa229@cornell.edu',  name: 'Ollie Aizer',        role: 'member', status: 'active',  subteam: 'Mechanical',  joined: ago(285) },
  { email: 'jc3391@cornell.edu', name: 'James Cenawood',     role: 'member', status: 'active',  subteam: 'Software',    joined: ago(270) },
  { email: 'nl733@cornell.edu',  name: 'Nick Lennon',        role: 'member', status: 'active',  subteam: 'Software',    joined: ago(268) },
  { email: 'jl3105@cornell.edu', name: 'Josh Lennon',        role: 'member', status: 'active',  subteam: 'Software',    joined: ago(268) },
  { email: 'ck694@cornell.edu',  name: 'Claire Kim',         role: 'member', status: 'invited', subteam: 'Electrical',  joined: null, invitedAt: ago(1, 3), invitedBy: 'ab3233@cornell.edu' },
];

/* ----------------------------------------------------------------------------
   Attachments. Diagrams are hand-drawn SVGs; the CAD sample is a binary STL
   generated at seed so the 3D viewer has something real to chew on.
   -------------------------------------------------------------------------- */

const svgUri = (s) => 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));

// Shared drawing vocabulary for the seeded diagrams: white paper, near-black ink.
const DIAGRAM_FONT = `font-family="Courier New,monospace"`;

const PDB_SVG = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 420" font-size="13">
<rect width="760" height="420" fill="#ffffff"/>
<g fill="none" stroke="#141414" stroke-width="1.5">
<rect x="40" y="170" width="150" height="80" rx="4"/>
<rect x="290" y="60" width="180" height="70" rx="4"/>
<rect x="290" y="175" width="180" height="70" rx="4"/>
<rect x="290" y="290" width="180" height="70" rx="4"/>
<rect x="570" y="60" width="150" height="70" rx="4"/>
<rect x="570" y="175" width="150" height="70" rx="4"/>
<rect x="570" y="290" width="150" height="70" rx="4"/>
<path d="M190 210 L240 210 L240 95 L290 95 M240 210 L290 210 M240 210 L240 325 L290 325"/>
<path d="M470 95 L570 95 M470 210 L570 210 M470 325 L570 325"/>
</g>
<g fill="#141414" ${DIAGRAM_FONT}>
<text x="115" y="205" text-anchor="middle">6S LiPo</text><text x="115" y="225" text-anchor="middle">22.2 V / 5200 mAh</text>
<text x="380" y="88" text-anchor="middle">Buck 12 V / 8 A</text><text x="380" y="108" text-anchor="middle">TPS56637</text>
<text x="380" y="203" text-anchor="middle">Buck 6.8 V / 12 A</text><text x="380" y="223" text-anchor="middle">servo rail</text>
<text x="380" y="318" text-anchor="middle">Buck 5 V / 6 A</text><text x="380" y="338" text-anchor="middle">logic rail</text>
<text x="645" y="88" text-anchor="middle">Jetson Orin</text><text x="645" y="108" text-anchor="middle">+ LiDAR</text>
<text x="645" y="203" text-anchor="middle">18x XM430</text><text x="645" y="223" text-anchor="middle">servo bus</text>
<text x="645" y="318" text-anchor="middle">STM32 + ESP32</text><text x="645" y="338" text-anchor="middle">sensors</text>
<text x="40" y="40" font-size="15">HEXAPOD PDB rev D — power tree</text>
<text x="40" y="395" fill="#8a8a8a">Fuse at battery: 60 A. Each rail fused + monitored (INA226) before the connector.</text>
</g></svg>`);

const LEG_SVG = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 440" font-size="13">
<rect width="760" height="440" fill="#ffffff"/>
<g fill="none" stroke="#141414" stroke-width="1.5">
<circle cx="150" cy="220" r="26"/><circle cx="150" cy="220" r="7"/>
<path d="M150 194 L330 130 M150 246 L330 182"/>
<circle cx="330" cy="156" r="22"/><circle cx="330" cy="156" r="6"/>
<path d="M330 134 L560 300 M330 178 L545 330"/>
<circle cx="556" cy="316" r="18"/>
<path d="M556 334 L590 402 L600 398"/>
</g>
<g fill="none" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="5 4">
<path d="M150 220 L150 80 M330 156 L330 80"/>
<path d="M330 156 L610 156 M556 316 L610 316"/>
</g>
<g fill="none" stroke="#141414" stroke-width="1">
<path d="M150 92 L330 92" marker-start="url(#a)" marker-end="url(#a)"/>
<path d="M598 156 L598 316"/>
</g>
<g fill="#141414" ${DIAGRAM_FONT}>
<text x="240" y="82" text-anchor="middle">L1 = 68 mm (coxa)</text>
<text x="620" y="240">L3 = 160 mm</text>
<text x="120" y="270">J1 (yaw)</text>
<text x="300" y="120">J2 (pitch)</text>
<text x="580" y="290">J3 (knee)</text>
<text x="40" y="40" font-size="15">HEXAPOD LEG — 3-DOF geometry, side view</text>
<text x="40" y="415" fill="#8a8a8a">Femur L2 = 210 mm between J2 and J3 pivots. Foot is a 12 mm TPU hemisphere.</text>
</g></svg>`);

const PINOUT_SVG = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 300" font-size="13">
<rect width="760" height="300" fill="#ffffff"/>
<g fill="none" stroke="#141414" stroke-width="1.5">
<rect x="60" y="70" width="200" height="150" rx="6"/>
<circle cx="110" cy="115" r="9"/><circle cx="160" cy="115" r="9"/><circle cx="210" cy="115" r="9"/>
<circle cx="110" cy="175" r="9"/><circle cx="160" cy="175" r="9"/><circle cx="210" cy="175" r="9"/>
</g>
<g fill="#141414" ${DIAGRAM_FONT}>
<text x="60" y="45" font-size="15">SENSOR BUS — JST-GH 6-pin, board edge view</text>
<text x="110" y="100" text-anchor="middle">1</text><text x="160" y="100" text-anchor="middle">2</text><text x="210" y="100" text-anchor="middle">3</text>
<text x="110" y="205" text-anchor="middle">4</text><text x="160" y="205" text-anchor="middle">5</text><text x="210" y="205" text-anchor="middle">6</text>
<text x="320" y="100">1  VCC 5 V (fused, 500 mA)</text>
<text x="320" y="125">2  CAN_H</text>
<text x="320" y="150">3  CAN_L</text>
<text x="320" y="175">4  UART_TX (3.3 V)</text>
<text x="320" y="200">5  UART_RX (3.3 V)</text>
<text x="320" y="225">6  GND</text>
<text x="60" y="265" fill="#8a8a8a">Pin 1 is nearest the board edge chamfer. Crimp with the PA-09; pull-test every lead.</text>
</g></svg>`);

// Binary STL of the MX bracket: an L-bracket built from axis-aligned boxes with a
// gusset. Overlapping solids are fine for shading — the viewer doesn't boolean.
function buildBracketStl() {
  const tris = [];
  const box = (x0, y0, z0, x1, y1, z1) => {
    const q = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };
    const p = (x, y, z) => [x, y, z];
    q(p(x0,y0,z1), p(x1,y0,z1), p(x1,y1,z1), p(x0,y1,z1));
    q(p(x1,y0,z0), p(x0,y0,z0), p(x0,y1,z0), p(x1,y1,z0));
    q(p(x0,y0,z0), p(x1,y0,z0), p(x1,y0,z1), p(x0,y0,z1));
    q(p(x1,y1,z0), p(x0,y1,z0), p(x0,y1,z1), p(x1,y1,z1));
    q(p(x1,y0,z0), p(x1,y1,z0), p(x1,y1,z1), p(x1,y0,z1));
    q(p(x0,y1,z0), p(x0,y0,z0), p(x0,y0,z1), p(x0,y1,z1));
  };
  box(0, 0, 0, 46, 30, 4);        // base plate
  box(0, 0, 0, 4, 30, 38);        // upright
  box(0, 13, 0, 20, 17, 22);      // gusset web
  box(38, 4, 0, 42, 26, 4);       // boss under slot
  const n = tris.length;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const t of tris) {
    const [a, b, c] = t;
    const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const nx = u[1]*v[2]-u[2]*v[1], ny = u[2]*v[0]-u[0]*v[2], nz = u[0]*v[1]-u[1]*v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    [nx/l, ny/l, nz/l, ...a, ...b, ...c].forEach((f, i) => dv.setFloat32(o + i*4, f, true));
    o += 50;
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:model/stl;base64,' + btoa(bin);
}

const SEED_ATTACHMENTS = [
  { id: 'att-crab', name: 'crab-on-beach.webp', type: 'image/webp', dataUri: CRAB_URI, by: 'ab3233@cornell.edu', ts: ago(180) },
  { id: 'att-pdb-tree',  name: 'pdb-rev-d-power-tree.svg',   type: 'image/svg+xml', dataUri: PDB_SVG,    by: 'js2801@cornell.edu', ts: ago(6) },
  { id: 'att-leg-geom',  name: 'leg-3dof-geometry.svg',      type: 'image/svg+xml', dataUri: LEG_SVG,    by: 'am3644@cornell.edu', ts: ago(12) },
  { id: 'att-pinout',    name: 'sensor-bus-jst-gh-pinout.svg', type: 'image/svg+xml', dataUri: PINOUT_SVG, by: 'js2801@cornell.edu', ts: ago(20) },
  { id: 'att-bracket',   name: 'mx64-bracket-rev-c.stl',     type: 'model/stl',     dataUri: buildBracketStl(), by: 'am3644@cornell.edu', ts: ago(4) },
];
SEED_ATTACHMENTS.forEach((a) => { a.size = Math.round((a.dataUri.length - a.dataUri.indexOf(',') - 1) * 3 / 4); });

/* ----------------------------------------------------------------------------
   Pages. body is the current text; revs are older versions, oldest first.
   -------------------------------------------------------------------------- */

const SEED_PAGES = [];
let seedOrder = 0;
function page(p) { SEED_PAGES.push({ revs: [], tags: [], parent: null, order: seedOrder++, ...p }); }

/* ------------------------------- Getting started ------------------------- */

page({
  id: 'welcome', section: 'getting-started', title: 'Welcome to the CUPI Wiki',
  owner: 'ab3233@cornell.edu', created: ago(180), updated: ago(0, 5), updatedBy: 'ab3233@cornell.edu',
  tags: ['start-here'],
  reactions: { '🦀': ['nl482@cornell.edu', 'js2801@cornell.edu', 'am3644@cornell.edu', 'jl3105@cornell.edu'], '👍': ['mr977@cornell.edu'] },
  body: `This is CUPI's internal knowledge base. Everything we learn the hard way — CAD conventions, board bring-up rituals, flight test procedure, who to email about lab access — gets written down here so the next person doesn't have to relearn it.

![Crab on the beach](att:att-crab "The apply-page crab. Physical intelligence, demonstrated.")

::: tip Write it down
If you explain something in Slack twice, it belongs on a wiki page. Press **N** anywhere (or the + next to a section name) and pick a template.

:::

## Where things live

| Section | What goes there |
| --- | --- |
| Getting Started | Your first two weeks: [[Onboarding Checklist]], accounts, lab access |
| Projects | One page per platform: [[Hexapod]], [[Scout Quadcopter]], [[Modovolo Payload]], [[AI Grand Prix]] |
| Mechanical | [[CAD Standards (Onshape)]], [[Part Numbering and BOM]], printing and machining |
| Electrical | [[Altium Workflow and Libraries]], [[Power Distribution Board]], [[Wiring and Connectors]] |
| Software | [[Dev Environment and Repos]], [[ROS 2 Perception Stack]], [[Flight Testing Procedure]] |
| Operations | [[Meeting Notes]], [[Budget and Purchasing]] |

## House rules

1. **Pages over threads.** Decisions made in meetings or Slack get captured the same day — use the meeting notes template.
2. **Attach the source.** Screenshots of CAD go next to a link to the Onshape document; schematic PDFs go next to the Altium 365 link. A picture without the source file is a dead end. See [[How to Use This Wiki]].
3. **Date your test data.** A measurement without a date and a setup is a rumor.

Syntax and everything the editor can do: [[Formatting Guide]]. Questions about access or accounts → [[Onboarding Checklist]] or ask ${'`#general`'}.`,
  revs: [
    { ts: ago(180), by: 'ab3233@cornell.edu', summary: 'Created page', body: 'Welcome to the CUPI wiki. More soon.' },
    { ts: ago(90), by: 'nl482@cornell.edu', summary: 'Added house rules', body: `This is CUPI's internal knowledge base.\n\n## House rules\n\n1. Pages over threads.\n2. Attach the source.\n3. Date your test data.` },
  ],
});

page({
  id: 'onboarding', section: 'getting-started', title: 'Onboarding Checklist',
  owner: 'nl482@cornell.edu', created: ago(160), updated: ago(2, 4), updatedBy: 'nl482@cornell.edu',
  tags: ['start-here'],
  body: `Work through this top to bottom. Most items unblock the ones after them. Your lead signs off at the bottom when you're done.

::: note This is the master copy
Don't check boxes here — **duplicate it** (••• menu → Duplicate), rename your copy to *Onboarding — Your Name*, and tick things off there. Leads keep this master current.

:::

## Accounts and access

- [x] Accept the wiki invite (you did — you're reading this)
- [ ] Join the Slack and post an intro in ${'`#general`'}
- [ ] Get added to the [Cornell-Physical-Intelligence GitHub org](https://github.com/Cornell-Physical-Intelligence)
- [ ] Onshape: ask a mechanical lead for edit access to the team workspace (see [[CAD Standards (Onshape)]])
- [ ] Altium 365: electrical members ask Jonathan or Mic for workspace access (see [[Altium Workflow and Libraries]])

## Lab

- [ ] Complete the Emerson student shop safety course in Upson (required before touching any machine)
- [ ] Card access to the lab — submit your ID number via the form pinned in ${'`#general`'}
- [ ] Read [[Lab Access and Safety]], especially the LiPo charging rules

## First build weekend

- [ ] Shadow a flight test and read [[Flight Testing Procedure]] first
- [ ] Print something on the Bambu X1Cs — [[3D Printing Guide]] covers slicer profiles
- [ ] Find your project page and add yourself to its roster table

::: note Leads
When a checklist item is wrong or stale, fix the page — don't route around it.

:::`,
});

page({
  id: 'lab-safety', section: 'getting-started', title: 'Lab Access and Safety',
  owner: 'oa229@cornell.edu', created: ago(150), updated: ago(9), updatedBy: 'oa229@cornell.edu',
  body: `The lab is a shared space and the fastest way to lose it is a safety incident. Read this before your first solo session.

## LiPo rules (non-negotiable)

- Charge only in the fireproof bags, only on the bench by the extinguisher, never unattended.
- Storage-charge (3.8 V/cell) anything that won't fly within 48 h. The cabinet log has a column for it.
- A puffed pack goes in the salt-water bucket outside, then to EH&S. Post in ${'`#electrical`'} so we track the failure.

## Machines

| Machine | Training needed | Notes |
| --- | --- | --- |
| Bambu X1C ×3 | None — read [[3D Printing Guide]] | Book on the sheet by the printers |
| Soldering / rework | Electrical lead walkthrough | Fume extractor on, always |
| Bandsaw, drill press | Emerson shop course | Card access proves completion |
| CNC router | Course + lead present | Aluminum only with mist coolant |

## After hours

Two-person rule after 22:00 for anything with spinning props, mains power, or the CNC. Solo CAD and soldering is fine.

::: warn Props off
Bench-testing a flight controller? Props come off before the battery goes on. No exceptions — this is our only standing rule with zero recorded violations. Keep it that way.

:::`,
});

page({
  id: 'how-to-wiki', section: 'getting-started', title: 'How to Use This Wiki',
  owner: 'ab3233@cornell.edu', created: ago(140), updated: ago(1, 2), updatedBy: 'ab3233@cornell.edu',
  body: `The wiki is plain Markdown with a few extras built for how a hardware team documents things. Full syntax lives in the **Formatting Guide** (link in the sidebar footer) — this page covers the parts people miss.

**Edit any page** with the **Edit** button at the top right, or press **E** while reading it. Every save is a revision, so edit boldly.

## Link pages together

Type ${'`[[Page Title]]`'} to link a page — the editor autocompletes after ${'`[['}\`. Links to pages that don't exist yet render red; clicking one offers to create the page. Every page lists what links *to* it at the bottom, so well-linked pages become hubs for free.

## Pictures, schematics, CAD

Drag any file into the editor (or paste a screenshot straight from the clipboard):

- **Images and SVGs** embed inline with an optional caption, and open in a lightbox.
- **STL / OBJ** get an interactive 3D viewer right in the page — drag to orbit.
- **STEP, F3D, SchDoc, PcbDoc, PDF** and anything else attach as a labeled file card.

## Live CAD links

Paste an **Onshape** document URL or an **Altium 365** share URL on its own line and it becomes a rich card. On the production wiki these upgrade to live thumbnails and embedded viewers; keep using them now so pages are ready.

## Templates

**N** opens the new-page dialog: meeting notes, design doc, decision record, test report, bring-up log, procedure. A decision that isn't in a [[Decision Records|decision record]] didn't happen.

## History is your safety net

Every save is a revision with a diff, and anything can be restored — edit boldly. Deleted pages sit in Trash for 30 days.`,
});

page({
  id: 'decisions', section: 'getting-started', title: 'Decision Records',
  owner: 'nl482@cornell.edu', created: ago(120), updated: ago(15), updatedBy: 'jc3391@cornell.edu',
  body: `One page per irreversible-ish decision, using the decision template. The point is that in a year, someone can find *why* — not relitigate it from memory.

## Index

| Date | Decision | Status |
| --- | --- | --- |
| 2026-02 | [[ADR: Onshape over SolidWorks]] | Adopted |
| 2026-03 | Dynamixel XM430 over cheap serial servos for hexapod joints | Adopted |
| 2026-04 | ESP-NOW (not Wi-Fi) for quad↔hexapod coordination link | Adopted |
| 2026-05 | Altium 365 workspace over local projects + Drive | Adopted |
| 2026-07 | Monocular + IMU only policy for VQ2 (rules change) | Forced |

Write the next one with **N → Decision record**. Keep the *Options considered* section honest — the rejected options are the valuable part. [[ADR: Onshape over SolidWorks]] is the exemplar; match its shape.`,
});

page({
  id: 'adr-onshape', section: 'getting-started', title: 'ADR: Onshape over SolidWorks',
  owner: 'am3644@cornell.edu', created: ago(175), updated: ago(175), updatedBy: 'am3644@cornell.edu',
  tags: ['decision'],
  body: `**Status:** Adopted · **Deciders:** Alan, Ollie, Andre · **Date:** 2026-02-11

## Context

Cornell's SolidWorks licenses only run on the lab Windows machines, half the team is on Macs, and file exchange through Drive kept producing "which SLDPRT is current" archaeology. We were spending build meetings resolving CAD versions instead of building.

## Options considered

1. **SolidWorks + PDM discipline** — best surfacing tools; but license-locked to lab machines, PDM costs money we don't have, and enforcement failed twice already.
2. **Fusion 360** — free for students, decent; but per-file cloud model made assemblies of 200+ parts painful in testing, and export lock-in worried us.
3. **Onshape** — browser-based so every laptop works day one, real branching/versioning built in, free education tier. Weaker surfacing and drawings than SolidWorks.

## Decision

Onshape, for all team CAD. The one reason that mattered most: **version control is the actual problem we have**, and Onshape's branch/merge/version model solves it structurally instead of by discipline.

## Consequences

- Easier: onboarding (nothing to install), design reviews (send a link), [[CAD Standards (Onshape)]] can mandate branching because it's free
- Harder: complex surfacing; anyone needing it prototypes in SolidWorks on a lab machine, then rebuilds the final in Onshape
- Revisit if: assemblies exceed Onshape's education-tier performance, or the education tier changes`,
});

page({
  id: 'formatting-guide', section: 'getting-started', title: 'Formatting Guide',
  owner: 'ab3233@cornell.edu', created: ago(140), updated: ago(1, 1), updatedBy: 'ab3233@cornell.edu',
  tags: ['reference'],
  body: `Everything is Markdown, with a few team extras. This page is itself editable proof — hit Edit to see its source.

## Text

**Bold**, *italic*, ~~strikethrough~~, ${'`inline code`'}, and [external links](https://cornellphysicalintelligence.com). Headings with ${'`##`'} and ${'`###`'} build the table of contents automatically.

## Linking pages

${'`[[Hexapod]]`'} → [[Hexapod]]. Add a label with ${'`[[Hexapod|the walker]]`'} → [[Hexapod|the walker]]. Link straight to a section: ${'`[[Hexapod#Leg design]]`'}. A link to a page that doesn't exist yet shows red — like [[Landing Gear Study]] — and clicking it creates the page.

## Lists and tasks

- Regular bullets and numbered lists nest by indentation
- [ ] Task items are live checkboxes — tick them right on the page
- [x] Done items cross out

## Callouts

::: note Three kinds
${'`::: note`'} , ${'`::: warn`'} , ${'`::: tip`'} — each with an optional title.

:::

## Tables

Click any column header to sort.

| Rail | Budget | Measured |
| --- | --- | --- |
| 5 V | 6 A | 4.4 A |
| 12 V | 8 A | 6.1 A |

## Code

~~~python
tau_inv = (w_t - w_prev) / (w_prev * dt)   # optical looming
~~~

## Pictures, CAD, schematics

Drag any file into the editor, or paste a screenshot:

- Images embed inline with an optional caption, and open in a lightbox
- STL/OBJ get an interactive 3D viewer, right in the page
- STEP, SchDoc, PDF, anything else becomes a labeled file card
- An **Onshape** or **Altium 365** URL pasted on its own line becomes a rich card

## Keyboard

| Key | Does |
| --- | --- |
| ⌘K | Search everything |
| N | New page |
| E | Edit the page you're reading |
| ⌘S / ⌘Enter | Save while editing |
| ⌘F | Find in the editor |
| ? | Keyboard shortcuts |
| Esc | Close anything (drafts are kept) |`,
});

/* ------------------------------- Projects -------------------------------- */

page({
  id: 'hexapod', section: 'projects', title: 'Hexapod',
  owner: 'nl482@cornell.edu', created: ago(200), updated: ago(1, 6), updatedBy: 'am3644@cornell.edu',
  tags: ['platform'],
  body: `Six-legged walking platform for ground autonomy: onboard perception, terrain-tolerant locomotion, and a coordination link to [[Scout Quadcopter]] for collaborative mapping.

## Current state

- 18 XM430 joints on a CAN-bridged servo bus; gait engine runs a 100 Hz tripod cycle
- Custom sensor board + [[Power Distribution Board|PDB rev D]] flying since July
- ESP-NOW link to the quad exchanges pose graphs at 5 Hz — see [[ROS 2 Perception Stack]]
- Exoskeleton panels printing now; leg rev C in test (see below)

## Leg design

![3-DOF leg geometry](att:att-leg-geom "Leg geometry, side view. L1 68 / L2 210 / L3 160 mm — sized so the knee servo never sees more than 60% stall torque in tripod gait.")

Kinematics and load cases live in [[Hexapod Leg Design]]. The printable bracket that ties the femur to the J3 servo:

!file[MX-64 bracket — rev C](att:att-bracket)

## Subsystem pages

- [[Hexapod Leg Design]] — geometry, materials, test results
- [[Power Distribution Board]] — power tree, fusing, INA226 telemetry
- [[Wiring and Connectors]] — the sensor bus standard this platform defined

## Roster

| Who | What |
| --- | --- |
| Nicholas Letendre | Platform lead, gait engine |
| Alan Munschy | Legs, exoskeleton |
| Jonathan Song | Sensor board, servo bus |
| Josh Lennon | Mapping + nav stack |`,
  revs: [
    { ts: ago(200), by: 'nl482@cornell.edu', summary: 'Created page', body: 'Six-legged walking platform. Page under construction.' },
    { ts: ago(40), by: 'nl482@cornell.edu', summary: 'Wrote current state + roster', body: `Six-legged walking platform for ground autonomy.\n\n## Current state\n\n- 18 XM430 joints on a CAN-bridged servo bus\n- Gait engine runs a 100 Hz tripod cycle\n\n## Roster\n\n| Who | What |\n| --- | --- |\n| Nicholas Letendre | Platform lead |` },
    { ts: ago(1, 6), by: 'am3644@cornell.edu', summary: 'Added leg drawing + bracket STL', body: null },
  ],
});

page({
  id: 'scout-quad', section: 'projects', title: 'Scout Quadcopter',
  owner: 'oa229@cornell.edu', created: ago(190), updated: ago(3, 2), updatedBy: 'mr977@cornell.edu',
  tags: ['platform'],
  body: `In-house 5" quad that scouts ahead of the [[Hexapod]]: downward camera + rangefinder, ESP-NOW telemetry, and enough compute to run gate/feature detection onboard.

## Airframe

- 5" prop, 220 mm wheelbase, printed arms on a carbon plate — mounts are modular so LiDAR and camera payloads swap without reflashing
- Prop guards sized for indoor flights; see weight budget below

## Electronics

- Sensor board rev B: ESP32 (ESP-NOW + telemetry), STM32 running the low-level loop
- Downward OV9281 global-shutter camera + VL53L1X rangefinder
- Power: 4S 1300 mAh through the shared [[Power Distribution Board|PDB]] BOM line

## Weight budget

| Group | Budget (g) | Actual (g) |
| --- | --- | --- |
| Frame + guards | 210 | 218 |
| Motors + ESCs | 190 | 186 |
| Electronics | 95 | 91 |
| Battery | 165 | 163 |
| **AUW** | **660** | **658** |

## Flying it

Nobody flies without reading [[Flight Testing Procedure]]. Coordination behavior with the hexapod is documented in [[ROS 2 Perception Stack]].`,
});

page({
  id: 'modovolo', section: 'projects', title: 'Modovolo Payload',
  owner: 'am3644@cornell.edu', created: ago(170), updated: ago(7), updatedBy: 'jc3391@cornell.edu',
  tags: ['platform', 'partner'],
  body: `Modular perception payload we build and fly on Modovolo's lift platform: 3D LiDAR + cameras + Jetson Orin in a housing that survives their vibration environment.

## Stack

| Layer | Part | Notes |
| --- | --- | --- |
| Sensing | Unitree L1 LiDAR + 2× OV9782 | LiDAR isolated on printed TPU grommets |
| Compute | Jetson Orin Nano | Runs the [[ROS 2 Perception Stack]] |
| Low level | STM32F405 | Power sequencing, watchdog, health LEDs |
| Power | 6S in via their bus | Our own regulation — see [[Power Distribution Board]] |

## Housing

Rev 3 housing is in the Onshape doc below. Design intent: the LiDAR window and both camera bores machine flat in one setup; everything else prints.

https://cad.onshape.com/documents/8f2c41d09a7e3b5a1c6f0d42/w/3a9b7c1e5d8f2a4b6c0e9d13/e/5f8a2b4c7d1e3f6a9b0c2d47

## Integration checklist

- [ ] Vibration isolation validated against their motor spectrum (sweep rig booked)
- [x] Power draw at full stack under their 90 W ceiling — measured 71 W peak
- [x] Quick-release checked against their mounting rail drawing
- [ ] Cold-start behavior below 0 °C`,
});

page({
  id: 'ai-grand-prix', section: 'projects', title: 'AI Grand Prix',
  owner: 'jc3391@cornell.edu', created: ago(185), updated: ago(0, 26), updatedBy: 'nl733@cornell.edu',
  tags: ['competition'],
  body: `Autonomous drone racing with the Drone Champions League. We passed **Virtual Qualifier 1** with a fully deterministic policy — no learned network in the loop, dead reckoning against the released course map with visual gate corrections.

## VQ2 (current)

VQ2 removes every pose and gate telemetry stream. What's left is a monocular camera and an IMU, so the policy now:

- guides on **bearings alone** — gate detections give direction, never range
- reads closing rate from **optical looming** (scale change of the gate quad between frames)
- carries attitude through gaps on IMU preintegration only

~~~python
# looming: expansion rate of gate bounding quad → time-to-contact proxy
tau_inv = (w_t - w_prev) / (w_prev * dt)     # 1/tau, w = quad width, px
commit  = tau_inv > TAU_COMMIT               # commit to the pass maneuver
~~~

Run logs and per-attempt notes live in the [[Flight Testing Procedure#Sim sessions|sim session log]]. The π0.5 manipulation work shares the arm lab — that's on [[Manipulation (π0.5)]].

## Working set

- Perception: James, Nick L — gate detector robustness under motion blur
- Policy: Josh — bearing-only guidance tuning, commit threshold sweep
- Infra: Andre — replay tooling, telemetry diffing between attempts`,
  revs: [
    { ts: ago(185), by: 'jc3391@cornell.edu', summary: 'Created page', body: 'Autonomous drone racing with DCL. VQ1 prep notes to follow.' },
    { ts: ago(60), by: 'jc3391@cornell.edu', summary: 'VQ1 passed — wrote up the deterministic policy', body: `Autonomous drone racing with the Drone Champions League. We passed **Virtual Qualifier 1** with a fully deterministic policy — no learned network in the loop.\n\n## How VQ1 worked\n\n- Dead reckoning against the released course map\n- Visual gate corrections when confidence is high` },
    { ts: ago(0, 26), by: 'nl733@cornell.edu', summary: 'VQ2: bearings + looming section', body: null },
  ],
});

page({
  id: 'pi05-arm', section: 'projects', title: 'Manipulation (π0.5)',
  owner: 'ab3233@cornell.edu', created: ago(90), updated: ago(5), updatedBy: 'ab3233@cornell.edu',
  tags: ['platform'],
  body: `We fine-tune Physical Intelligence's open **π0.5** vision-language-action model on our own arm. The released checkpoint brings broad manipulation priors; our work is adapting it to our grippers, camera placement, and tasks.

## Rig

- 6-DOF printed arm, parallel-jaw gripper (TPU pads, see [[3D Printing Guide]])
- Two OV9782 cameras: wrist + overhead, calibrated weekly (calibration board hangs by the rig)
- Teleop via SpaceMouse for demonstration collection

## Data discipline

::: warn Label the take
Every demonstration episode gets task string, date, and operator in the filename **at record time**. We lost a weekend re-sorting untagged takes in June. Not again.

:::

## Current tasks

| Task | Demos | Success (eval) |
| --- | --- | --- |
| Pick ball → bin | 140 | 82% |
| Cable into clip | 95 | 61% |
| Cut (guided blade) | 60 | 44% |

Fine-tuning configs and eval harness: ${'`pi05-cupi`'} repo — see [[Dev Environment and Repos]].`,
});

/* ------------------------------- Mechanical ------------------------------ */

page({
  id: 'cad-standards', section: 'mechanical', title: 'CAD Standards (Onshape)',
  owner: 'am3644@cornell.edu', created: ago(155), updated: ago(4, 3), updatedBy: 'am3644@cornell.edu',
  tags: ['standard'],
  body: `All team CAD lives in the Onshape team workspace (decision record: Onshape over SolidWorks, 2026-02 — browser-based meant zero install pain and real branching). Ask a mechanical lead for access during [[Onboarding Checklist|onboarding]].

## Document layout

One Onshape **document per assembly**, named ${'`CUPI-<project>-<assembly>`'} (e.g. ${'`CUPI-HEX-LEG`'}). Inside:

- ${'`main`'} workspace is always buildable — no broken features on main
- Branch for experiments; merge only after a lead looks at it
- Version (snapshot) before every physical build, named ${'`build-YYYY-MM-DD`'}

## Part studios

- Origin at the assembly's natural datum (servo bore, board mount plane), axes labeled in a note
- Every dimension that mates with another part gets a **variable** (${'`#bolt_circle`'}, ${'`#servo_w`'}) — magic numbers in sketches are how rev C stops fitting rev D
- Materials assigned in Onshape so mass properties are trustworthy — the [[Scout Quadcopter]] weight budget reads straight from the model

## Exports

| Purpose | Format | Where |
| --- | --- | --- |
| Print | STL / 3MF | Attach to the part's wiki page |
| Machine | STEP + PDF drawing | Attach to the wiki page **and** the [[Machining Resources|machining request]] |
| Archive | Onshape version | Link the version, not the workspace |

Example of the pattern done right: [[Hexapod Leg Design]].`,
});

page({
  id: 'part-numbering', section: 'mechanical', title: 'Part Numbering and BOM',
  owner: 'am3644@cornell.edu', created: ago(150), updated: ago(11), updatedBy: 'oa229@cornell.edu',
  tags: ['standard'],
  body: `One numbering scheme across mechanical and electrical so a BOM line, an Onshape part, and a bag on the shelf all carry the same name.

## Scheme

~~~
CUPI-<PROJ>-<SYS>-<NNN>[-rev]
       HEX    LEG   012   C
~~~

- ${'`PROJ`'}: HEX, SQD (Scout quad), MOD, AGP, ARM
- ${'`SYS`'}: LEG, FRM, PDB, SNS, HSG, HW (fasteners/COTS)
- ${'`NNN`'}: three digits, never reused; rev letters only after something physical exists

## BOM rules

- Every assembly page carries its BOM as a table with **vendor, part no., qty, unit cost, link**
- COTS parts get a CUPI-…-HW number too — "the M3 standoffs" is not a part
- Purchasing pulls from BOM tables directly — a part not on a BOM does not get ordered (see [[Budget and Purchasing]])

## Example

| Part | Number | Qty | Vendor | Unit |
| --- | --- | --- | --- | --- |
| Femur tube, carbon 12 mm | CUPI-HEX-LEG-004 | 6 | DragonPlate | $11.40 |
| MX-64 bracket rev C | CUPI-HEX-LEG-012-C | 6 | printed | — |
| M3×8 SHCS | CUPI-HEX-HW-021 | 48 | McMaster 91290A113 | $0.09 |`,
});

page({
  id: 'printing', section: 'mechanical', title: '3D Printing Guide',
  owner: 'oa229@cornell.edu', created: ago(145), updated: ago(6, 8), updatedBy: 'am3644@cornell.edu',
  body: `Three Bambu X1Cs live in the lab. Book on the paper sheet; the queue self-organizes if you write honest print times.

## Profiles that work

| Use | Material | Profile notes |
| --- | --- | --- |
| Structural (brackets, mounts) | PAHT-CF | 0.16 mm, 6 walls, 40% gyroid — dry the spool, always |
| General fit checks | PLA | Stock 0.20 mm, 3 walls |
| Compliant (feet, grommets, gripper pads) | TPU 95A | 0.20 mm, 2 walls, 20%, slow outer wall |
| Cosmetic panels | PETG | 0.20 mm, fuzzy skin on show faces |

## Rules of thumb

- Orient so layer lines run **across** bending loads, not along them. The rev A leg brackets failed at 60% load through layer adhesion — rev C prints rotated 90° and hasn't failed since ([[Hexapod Leg Design#Test results]]).
- Holes print 0.2 mm undersize: drill or ream anything that carries a shaft or bolt.
- Heat-set inserts: 260 °C tip, press slow, let it self-align. Practice on scrap first.

::: note CF filament
Carbon-filled filament needs the hardened nozzle — it's the one marked with red tape. Swapping to brass for CF will ruin the nozzle and your afternoon.

:::`,
});

page({
  id: 'leg-design', section: 'mechanical', title: 'Hexapod Leg Design',
  reactions: { '👍': ['nl733@cornell.edu', 'js2801@cornell.edu'] },
  owner: 'am3644@cornell.edu', created: ago(100), updated: ago(2, 7), updatedBy: 'am3644@cornell.edu',
  tags: ['design-doc'],
  body: `Design record for the 3-DOF leg: geometry, load cases, materials, and what broke. Kinematic constants here are the source of truth — the gait engine imports them by name.

## Geometry

![Leg geometry drawing](att:att-leg-geom "J1 yaw at the body, J2 pitch, J3 knee. L1 68 / L2 210 / L3 160 mm.")

Link lengths were chosen so the knee servo stays under 60% stall torque through the tripod-gait envelope with a 2.5 kg body mass at 1.5× dynamic factor:

~~~
tau_knee = m_eff * g * L3 * cos(theta_ground)   # worst case at touchdown
XM430 stall = 4.1 N·m @ 12 V → design ceiling 2.5 N·m
~~~

## CAD

Live model (branch ${'`leg-rev-c`'} merged to main 2026-08-12):

https://cad.onshape.com/documents/2b7e91c44f8a0d63e5a12b90/w/9c4d2e7a1b5f8c3d6e0a4f21/e/7a1c5e9b3d6f0a2c4e8b1d35

The J3 bracket, printable — orbit it here before printing:

!file[MX-64 bracket — rev C](att:att-bracket)

## Test results

| Rev | Test | Result |
| --- | --- | --- |
| A | Static load to 2× body mass | **Failed** — bracket delaminated at 60%, layer orientation |
| B | Same | Passed static, cracked in drop test (8 mm fillet added) |
| C | Static + 30 cm drop, 500-cycle gait rig | **Passed** — adopted 2026-08-12 |

## Open

- [ ] TPU foot wear rate on concrete — inspect after every 10 field hours
- [ ] J2 bearing seat reams 0.05 mm loose on printer #2 — tolerance study pending`,
  revs: [
    { ts: ago(100), by: 'am3644@cornell.edu', summary: 'Created from design doc template', body: 'Design record for the 3-DOF leg. Geometry TBD after torque study.' },
    { ts: ago(30), by: 'am3644@cornell.edu', summary: 'Rev B test results', body: `Design record for the 3-DOF leg.\n\n## Test results\n\n| Rev | Test | Result |\n| --- | --- | --- |\n| A | Static load to 2× body mass | **Failed** — bracket delaminated at 60% |\n| B | Same | Passed static, cracked in drop test |` },
    { ts: ago(2, 7), by: 'am3644@cornell.edu', summary: 'Rev C adopted; linked Onshape + STL', body: null },
  ],
});

page({
  id: 'machining', section: 'mechanical', title: 'Machining Resources',
  owner: 'oa229@cornell.edu', created: ago(130), updated: ago(18), updatedBy: 'oa229@cornell.edu',
  body: `For anything the printers can't make. Emerson shop handles most of it; the lab CNC router covers flat aluminum.

## Requesting a machined part

1. Export **STEP + a dimensioned PDF drawing** from Onshape ([[CAD Standards (Onshape)]] has the drawing template)
2. Attach both to the part's wiki page, with tolerances called out — "±0.1 unless noted"
3. Post the page link in ${'`#mechanical`'} with your deadline

## Shop options

| Shop | Good for | Lead time |
| --- | --- | --- |
| Emerson (student shop) | Mills, lathes, waterjet | You do the work — book after shop course |
| Lab CNC router | 2D aluminum ≤ 8 mm, mist coolant | Same week |
| RPL | SLA/SLS when FDM won't cut it | ~1 week |
| Protolabs (sponsor credit) | Tight-tolerance or many parts | 2 weeks — leads approve, see [[Budget and Purchasing]] |

Feeds and speeds cheat sheet is taped inside the router enclosure. When in doubt, half the feed and ask in ${'`#mechanical`'}.`,
});

/* ------------------------------- Electrical ------------------------------ */

page({
  id: 'altium', section: 'electrical', title: 'Altium Workflow and Libraries',
  owner: 'js2801@cornell.edu', created: ago(148), updated: ago(3, 9), updatedBy: 'mr977@cornell.edu',
  tags: ['standard'],
  body: `All boards are designed in **Altium Designer** against the team's **Altium 365** workspace (student licenses — ask Jonathan for a seat and workspace access). Local projects synced to Drive died in 2026-05; everything lives in 365 now.

## Workspace layout

- One project per board: ${'`CUPI-<PROJ>-<BOARD>`'} matching [[Part Numbering and BOM]]
- The **managed library** is the only component source. Need a part? Add it to the library with symbol + footprint + LCSC/Digi-Key supplier link, then use it. No loose SchLib files.
- Releases: every fab order is an Altium release, tagged ${'`rev<letter>`'} — the fab zip on the wiki page must come from a release, never a working copy

## Sharing a design

Paste the Altium 365 share link on the board's wiki page — like the [[Power Distribution Board]] does:

https://cupi-365.altium.com/designs/A9F2C4D1-7B3E-4E8A-9C1D-2F5B8E0A4C67

Reviewers comment in 365 on the schematic itself; conclusions get written back to the wiki page.

## Review gate

No board goes to fab without a recorded review pass against the [[PCB Design Checklist]] — two reviewers, one of them a lead. The checklist page explains the ritual.`,
});

page({
  id: 'pcb-checklist', section: 'electrical', title: 'PCB Design Checklist',
  owner: 'mr977@cornell.edu', created: ago(147), updated: ago(8, 2), updatedBy: 'js2801@cornell.edu',
  tags: ['standard', 'checklist'],
  body: `Run this top to bottom before every fab order. Copy the checklist into the board's page, check items there, and link the two reviewers. History shows who checked what — that's the point.

## Schematic

- [ ] Every net named; no ${'`NetR12_1`'} survivors
- [ ] Decoupling per datasheet, placed logically near each IC in the sheet
- [ ] Connector pinouts match [[Wiring and Connectors]] — check pin 1 convention **twice**
- [ ] Reverse-polarity and overcurrent protection at every external power entry
- [ ] Test points on every rail and every debug-relevant signal

## Layout

- [ ] Ground pours stitched; return paths traced by eye for every high-current loop
- [ ] Buck converters follow the datasheet layout — hot loop minimized before anything else is placed
- [ ] Mounting holes grounded through a ferrite where chassis meets logic ground
- [ ] Silk: board name, rev, date, and a blank "bring-up by ___" box
- [ ] Courtyard clearances pass at 0.15 mm; no silk over pads

## Before upload

- [ ] DRC clean at the fab's real rule set (JLC 6/6 unless justified)
- [ ] 3D export checked against the enclosure in Onshape ([[CAD Standards (Onshape)]])
- [ ] Release created in Altium 365, fab zip attached to the board's wiki page

::: tip Reviews catch what you stopped seeing
Rev B of the sensor board shipped with UART TX→TX because the reviewer "knew it was fine." Both reviewers walk the checklist independently now.

:::`,
});

page({
  id: 'pdb', section: 'electrical', title: 'Power Distribution Board',
  reactions: { '🚀': ['nl482@cornell.edu', 'ab3233@cornell.edu'], '👀': ['am3644@cornell.edu'] },
  owner: 'js2801@cornell.edu', created: ago(95), updated: ago(0, 8), updatedBy: 'js2801@cornell.edu',
  tags: ['board'],
  body: `PDB rev D: the [[Hexapod]]'s power backbone — 6S in, three regulated rails out, per-rail fusing and INA226 telemetry on everything.

## Power tree

![PDB rev D power tree](att:att-pdb-tree "Battery → three synchronous bucks. Every rail is fused and current-monitored before it reaches a connector.")

## Design

Altium 365 (release ${'`revD`'}, fabbed 2026-07-28 at JLC):

https://cupi-365.altium.com/designs/A9F2C4D1-7B3E-4E8A-9C1D-2F5B8E0A4C67

Checklist review: Jonathan + Mic, 2026-07-21 — recorded in this page's history.

## Bring-up (rev D)

Followed the [[Board Bring-Up Log]] ritual:

1. Visual + shorts check — pass
2. Bench supply, current-limited, no loads: all rails in regulation, ripple < 40 mV pp
3. Rail-by-rail load test to 120% rating — 6.8 V rail sagged 3% at 14 A, within spec
4. INA226 telemetry vs bench meter: within 2% on all rails
5. Full stack: 22 min soak at gait load, hottest FET 61 °C

::: warn Known issue
The 5 V rail's inrush trips the polyfuse if the Jetson and LiDAR cold-start together. Workaround: STM32 staggers the LiDAR enable by 400 ms. Fix queued for rev E (bigger fuse + soft-start).

:::

## BOM extract

| Part | Number | Vendor |
| --- | --- | --- |
| PDB rev D bare board | CUPI-HEX-PDB-001-D | JLCPCB |
| TPS56637 ×3 | CUPI-HEX-PDB-HW-003 | Digi-Key |
| INA226 ×4 | CUPI-HEX-PDB-HW-007 | LCSC |`,
  revs: [
    { ts: ago(95), by: 'js2801@cornell.edu', summary: 'Created from design doc template', body: 'PDB for the hexapod. Rev C notes to be ported.' },
    { ts: ago(22), by: 'mr977@cornell.edu', summary: 'Rev D sent to fab; checklist review recorded', body: `PDB rev D: the hexapod's power backbone.\n\n## Design\n\nAltium 365 release revD, fabbed at JLC.\n\nChecklist review: Jonathan + Mic, 2026-07-21.` },
    { ts: ago(0, 8), by: 'js2801@cornell.edu', summary: 'Bring-up results + inrush known issue', body: null },
  ],
});

page({
  id: 'wiring', section: 'electrical', title: 'Wiring and Connectors',
  owner: 'js2801@cornell.edu', created: ago(140), updated: ago(13), updatedBy: 'js2801@cornell.edu',
  tags: ['standard'],
  body: `One connector standard across every platform so harnesses interchange and nobody plugs 22 V into a 5 V sensor again (we did this once; the magic smoke was expensive).

## The standard

| Signal class | Connector | Wire |
| --- | --- | --- |
| Battery / high current | XT60 (XT30 under 10 A) | 14–16 AWG silicone |
| Servo bus | JST-PH 3-pin | 20 AWG |
| Sensor bus (CAN + UART) | **JST-GH 6-pin** | 26 AWG twisted for CAN pair |
| Debug | TC2030 tag-connect | — |

## Sensor bus pinout

![JST-GH sensor bus pinout](att:att-pinout "Pin 1 nearest the chamfer. This exact drawing is silk-screened on every board that carries the bus.")

Keyed housings make reversal impossible **only if** every board follows this pin order — that's why [[PCB Design Checklist]] makes you check it twice.

## Crimping

- PA-09 for JST; the good crimper lives in the red toolbox, comes back to the red toolbox
- Every crimp gets a pull test. Every harness gets continuity-buzzed end to end before first power.
- Label both ends with source → destination (e.g. ${'`P3: PDB → J3 servo`'}): heat-shrink labels, not tape flags`,
});

page({
  id: 'bringup', section: 'electrical', title: 'Board Bring-Up Log',
  owner: 'mr977@cornell.edu', created: ago(90), updated: ago(4, 6), updatedBy: 'mr977@cornell.edu',
  tags: ['checklist'],
  body: `Bring-up is a ritual, not a judgment call. Copy this sequence into the board's page per unit; a board without a completed log doesn't get integrated.

## Sequence

1. **Visual** under the microscope: bridges, tombstones, missing parts, solder balls under QFNs
2. **Shorts**: continuity every rail → GND before any power
3. **First power**: bench supply, current limit 50 mA above expected idle, **no loads connected**
4. **Rails**: regulation + ripple scope check at each test point (this is why the [[PCB Design Checklist]] demands test points)
5. **Comms**: enumerate every bus — SWD, then CAN/UART/I²C per the [[Wiring and Connectors]] pinout
6. **Load**: rail-by-rail to 120% of rated, watch thermals
7. **Firmware smoke test**: blink + watchdog + telemetry heartbeat
8. Fill the silk-screen "bring-up by ___" box with initials and date. Yes, with a paint pen.

## Template row

~~~
Unit #2 · 2026-08-14 · MR
1 visual: ok  2 shorts: ok  3 first power: 31 mA idle (exp 28)
4 rails: ok, 5V ripple 22 mV  5 comms: ok  6 load: ok  7 fw: ok
~~~

Recent example with real data: [[Power Distribution Board#Bring-up (rev D)]].`,
});

/* ------------------------------- Software -------------------------------- */

page({
  id: 'dev-env', section: 'software', title: 'Dev Environment and Repos',
  owner: 'nl733@cornell.edu', created: ago(135), updated: ago(5, 4), updatedBy: 'jc3391@cornell.edu',
  body: `Everything lives in the [Cornell-Physical-Intelligence GitHub org](https://github.com/Cornell-Physical-Intelligence). Get added during [[Onboarding Checklist|onboarding]].

## Repos

| Repo | What | Stack |
| --- | --- | --- |
| ${'`hexapod`'} | Gait engine, servo bus, mapping | ROS 2 Jazzy, C++/Python |
| ${'`scout`'} | Quad firmware + coordination | STM32 HAL, ESP-IDF |
| ${'`agp`'} | AI Grand Prix policy + replay tools | Python, sim harness |
| ${'`pi05-cupi`'} | π0.5 fine-tune configs, eval harness | Python, JAX |
| ${'`perception`'} | Shared LiDAR/camera nodes | ROS 2, CUDA |

## Setup

~~~bash
# Ubuntu 24.04 or the lab machines. One script, ~20 min:
git clone git@github.com:Cornell-Physical-Intelligence/perception.git
cd perception && ./tools/setup.sh   # ROS 2 Jazzy + deps + pre-commit
~~~

- Jetson images: flashed from ${'`perception/images/`'} — don't hand-configure a Jetson, we will not be able to reproduce it
- Pre-commit is mandatory (format + lint); CI mirrors it exactly
- Hardware-in-loop test benches are labeled on the shelf — book like printers

## Conventions

- Branches ${'`name/short-topic`'}; PRs need one review; ${'`main`'} deploys to robots
- A PR that changes a physical interface (pinout, connector, mount) links the wiki page it affects — reviewers check the page got updated too`,
});

page({
  id: 'perception', section: 'software', title: 'ROS 2 Perception Stack',
  owner: 'jc3391@cornell.edu', created: ago(125), updated: ago(1, 9), updatedBy: 'jl3105@cornell.edu',
  body: `Shared perception layer for [[Hexapod]], [[Scout Quadcopter]] and the [[Modovolo Payload]]: LiDAR + camera in, registered clouds, obstacle grid, and (new) the cross-robot pose graph out.

## Topology

~~~
lidar_driver ─┐
              ├─ registration ── local_map ── nav_grid
cam_driver  ──┘        │
                  pose_graph ⇄ espnow_bridge ⇄ [other robot]
~~~

- Runs on Jetson Orin Nano (Modovolo, hexapod) and Orin NX (bench)
- ${'`espnow_bridge`'} exchanges pose-graph deltas at 5 Hz over the ESP-NOW link — the quad scouts, the hexapod refines ground truth where it walks
- All parameters in ${'`perception/config/*.yaml`'}, one file per platform. **No literals in launch files** — the VQ2 rules change was a one-file diff because of this.

## Latency budget (Orin Nano, 2026-08)

| Stage | Budget | Measured |
| --- | --- | --- |
| LiDAR decode | 8 ms | 6.2 ms |
| Registration | 22 ms | 19.8 ms |
| Grid update | 10 ms | 7.1 ms |
| **End to end** | **45 ms** | **38.4 ms** |

Regression gate: CI replays the ${'`bench-loop`'} bag and fails if end-to-end exceeds budget. Don't merge around it — fix the regression.`,
});

page({
  id: 'flight-testing', section: 'software', title: 'Flight Testing Procedure',
  owner: 'nl733@cornell.edu', created: ago(115), updated: ago(2, 1), updatedBy: 'nl733@cornell.edu',
  tags: ['checklist'],
  body: `Applies to every powered flight, indoor or field. The procedure exists because of specific incidents; each rule has a story. Ask about them.

## Roles

Two people minimum: **pilot** (sticks or kill switch, nothing else) and **test director** (checklist, logging, airspace). Observers stand behind the net.

## Preflight

- [ ] Battery charged + logged, pack number recorded ([[Lab Access and Safety]] LiPo rules)
- [ ] Props inspected — any chip or crack, replace, no debate
- [ ] Failsafe verified **on the bench, props off**: kill switch drops motors in < 200 ms
- [ ] Test card written: what changed since last flight, what we're measuring, abort criteria
- [ ] Telemetry link green; logging armed (bags auto-named from the test card)

## During

- One variable per flight. If the test card says "new gate detector," the tune stays frozen.
- Test director calls out battery voltage every 30 s under 15.2 V.
- **Anyone** can call abort. The word is "LAND," said loud, once.

## After

- [ ] Bag file + test card + outcome pushed to ${'`agp/logs`'} or platform repo before the battery goes back on the charger
- [ ] Anomalies get a line on the platform page the same day

## Sim sessions

Sim attempts for [[AI Grand Prix]] follow the same card discipline — the replay tooling diffs telemetry between attempts, which only works if every run is labeled.`,
});

/* ------------------------------- Operations ------------------------------ */

page({
  id: 'meeting-notes', section: 'operations', title: 'Meeting Notes',
  owner: 'ab3233@cornell.edu', created: ago(120), updated: ago(4, 20), updatedBy: 'ab3233@cornell.edu',
  body: `General meetings are Thursdays 19:00, Upson 116. Notes are taken live on a subpage of this one — **N → Meeting notes**, title it ${'`General Meeting — YYYY-MM-DD`'}, and add a row to the table below so it's findable.

## This semester

| Date | Notes | Highlights |
| --- | --- | --- |
| 2026-08-14 | [[General Meeting — 2026-08-14]] | Leg rev C adopted · VQ2 sim status · recruiting dates |

Older semesters get archived into a subpage per semester once the table gets long.`,
});

page({
  id: 'meeting-2026-08-14', section: 'operations', title: 'General Meeting — 2026-08-14',
  reactions: { '✅': ['nl482@cornell.edu'] },
  owner: 'ab3233@cornell.edu', created: ago(5, 2), updated: ago(4, 22), updatedBy: 'ab3233@cornell.edu',
  tags: ['meeting'],
  body: `**Attending:** Andre, Nicholas, Jonathan, Mic, Alan, Ollie, James, Nick L, Josh · **Notes:** Andre

## Agenda

1. VQ2 status and sim schedule
2. Hexapod leg rev C adoption
3. Fall recruiting

## Notes

- **VQ2** (James): bearing-only guidance passes 7/10 sim courses; failures are all late commits in the S-bend. Josh sweeping ${'`TAU_COMMIT`'} this week — results to [[AI Grand Prix]].
- **Leg rev C** (Alan): 500-cycle rig run clean. Rev C **adopted** — recorded in [[Hexapod Leg Design]]. Printing 8 brackets (6 + 2 spares).
- **PDB** (Jonathan): rev D bring-up done; inrush workaround documented on [[Power Distribution Board]]. Rev E queued, not urgent.
- **Recruiting** (Andre): apply page live. Info session Sep 3, project fair Sep 6. Subteam leads each own a demo.

## Actions

- [ ] Josh — ${'`TAU_COMMIT`'} sweep, post replay diffs *(Fri)*
- [x] Alan — order PAHT-CF spools ×3 via [[Budget and Purchasing]]
- [ ] Mic — rev E fuse + soft-start sketch into the Altium project
- [ ] Ollie — info session slides, hardware table plan
- [ ] Andre — invite the three new ECE walk-ons to the wiki *(done for Claire, two pending emails)*`,
});

page({
  id: 'budget', section: 'operations', title: 'Budget and Purchasing',
  owner: 'ab3233@cornell.edu', created: ago(110), updated: ago(10), updatedBy: 'ab3233@cornell.edu',
  body: `How money moves. Short version: BOM line → request → lead approves → order goes out twice a week.

## Requesting a purchase

1. The part is on a BOM table on a wiki page ([[Part Numbering and BOM]] — this is the forcing function)
2. Post the page link + line items in ${'`#purchasing`'}
3. A lead reacts ✅ (that's the approval record), Andre or Nicholas places it Tue/Fri
4. Delivered → check it in on the BOM row (qty on hand)

## Ceilings

| Amount | Needs |
| --- | --- |
| < $50 | Any lead ✅ |
| $50–300 | Andre or Nicholas |
| > $300 | Both + a sentence of justification on the wiki page |

Sponsor credits (Protolabs, JLC) route the same way — they're still budget, just not cash. Current balances live in the pinned sheet in ${'`#purchasing`'}.`,
});

/* ----------------------------------------------------------------------------
   Activity — derived from revisions plus a few reads/uploads for texture.
   -------------------------------------------------------------------------- */

const SEED_ACTIVITY = [
  { ts: ago(0, 5), by: 'ab3233@cornell.edu', kind: 'edit', pageId: 'welcome', summary: 'Linked the formatting guide' },
  { ts: ago(0, 8), by: 'js2801@cornell.edu', kind: 'edit', pageId: 'pdb', summary: 'Bring-up results + inrush known issue' },
  { ts: ago(0, 26), by: 'nl733@cornell.edu', kind: 'edit', pageId: 'ai-grand-prix', summary: 'VQ2: bearings + looming section' },
  { ts: ago(1, 2), by: 'ab3233@cornell.edu', kind: 'edit', pageId: 'how-to-wiki', summary: 'CAD link cards section' },
  { ts: ago(1, 3), by: 'ab3233@cornell.edu', kind: 'invite', who: 'ck694@cornell.edu' },
  { ts: ago(1, 6), by: 'am3644@cornell.edu', kind: 'edit', pageId: 'hexapod', summary: 'Added leg drawing + bracket STL' },
  { ts: ago(1, 9), by: 'jl3105@cornell.edu', kind: 'edit', pageId: 'perception', summary: 'Latency budget table refresh' },
  { ts: ago(2, 1), by: 'nl733@cornell.edu', kind: 'edit', pageId: 'flight-testing', summary: 'Sim sessions section' },
  { ts: ago(2, 7), by: 'am3644@cornell.edu', kind: 'edit', pageId: 'leg-design', summary: 'Rev C adopted; linked Onshape + STL' },
  { ts: ago(4, 22), by: 'ab3233@cornell.edu', kind: 'edit', pageId: 'meeting-2026-08-14', summary: 'Actions updated after standup' },
];

/* ----------------------------------------------------------------------------
   Templates
   -------------------------------------------------------------------------- */

const TEMPLATES = [
  { id: 'blank', name: 'Blank page', desc: 'Start from nothing', body: '' },
  { id: 'meeting', name: 'Meeting notes', desc: 'Agenda, notes, decisions, actions', body: `**Attending:** · **Scribe:**\n\n## Agenda\n\n1. Topic — who's driving it\n\n## Notes\n\n- **Topic** (who): what was reported or changed, and the page it lands on — link it\n\n## Decisions\n\n- What we chose, one line each. Anything hard to reverse gets its own [[Decision Records|decision record]] instead.\n\n## Actions\n\n- [ ] Who — what *(by when)*\n\n::: tip Before you close the tab\nTitle this page \`General Meeting — YYYY-MM-DD\` and add a row to the table on [[Meeting Notes]] — otherwise nothing links here and it shows up as an orphan.\n\n:::\n` },
  { id: 'design', name: 'Design doc', desc: 'Requirements, design, tests, BOM', body: `**Part:** CUPI-<PROJ>-<SYS>-<NNN> · **Rev:** A · **Owner:** · **Status:** In design\n\nWhat this is, which platform it serves, and the requirement it answers. If other pages or code read numbers off this page, say so — that's what makes it the source of truth.\n\n## Requirements\n\n- Constraint — the number, and where the number came from\n- Constraint — the number, and where the number came from\n\n## Design\n\nDrag the drawing, sketch or screenshot in here and caption it. Then paste the Onshape or Altium 365 link on its own line so it renders as a live card.\n\nWorst-case sizing math goes in a code block so a reviewer never has to re-derive it. Review: who signed off and when — boards need two reviewers against [[PCB Design Checklist]], one of them a lead.\n\n## Test results\n\n| Rev | Test | Result |\n| --- | --- | --- |\n| *A* | *static load to 2× body mass* | *failed — delaminated at 60%, layer orientation* |\n\n## BOM extract\n\n| Part | Number | Qty | On hand | Vendor | Unit cost |\n| --- | --- | ---: | ---: | --- | ---: |\n|  |  |  |  |  |  |\n\nAn italic table row is an example — replace it. Numbering and the full column set: [[Part Numbering and BOM]].\n\n## Open\n\n- [ ] What's unresolved — owner, and what would close it\n\n::: warn Known issue\nWhat bites you today, the workaround people actually use, and which rev fixes it. Delete this block if nothing does.\n\n:::\n` },
  { id: 'decision', name: 'Decision record', desc: 'Context, options, outcome', body: `**Status:** Proposed · **Deciders:** · **Date:** YYYY-MM-DD\n\n## Context\n\nWhat forced a decision now — the constraint, the failure, or the rule change. Whoever reads this in a year has none of your memory.\n\n## Options considered\n\n1. **Option A** — what it gets us, and the specific reason it won or lost\n2. **Option B** — what it gets us, and the specific reason it won or lost\n\n## Decision\n\nWhat we chose, and the one reason that mattered most.\n\n## Consequences\n\n- Easier:\n- Harder:\n- Revisit if:\n\n::: tip Make it findable\nFlip **Status** to Adopted once it's real, and add a row to the index on [[Decision Records]].\n\n:::\n` },
  { id: 'test', name: 'Test report', desc: 'Setup, data, verdict', body: `**Date:** YYYY-MM-DD · **Who:** · **Unit / rev:**\n\n## Setup\n\nWhich procedure you followed (link it — e.g. [[Flight Testing Procedure]], [[Board Bring-Up Log]]), on what rig, and **what changed since the last run**. One variable at a time or the numbers mean nothing. Drag in a photo of the setup — a bench nobody can picture can't be rebuilt.\n\n## Data\n\n| Metric | Expected | Measured |\n| --- | ---: | ---: |\n| *5 V rail ripple* | *< 40 mV pp* | *22 mV pp* |\n\nAn italic row is an example — replace it. Raw data: bag file, log path or repo, so someone else can re-derive this table.\n\n## Verdict\n\nPass or fail, and what changes because of it.\n\n## Follow-ups\n\n- [ ] Who — what *(by when)*\n` },
  { id: 'bringup', name: 'Bring-up log', desc: 'Per-unit board checklist', body: `**Board:** CUPI-<PROJ>-<BOARD>-<NNN> · **Rev:** · **Ritual:** [[Board Bring-Up Log]]\n\nOne row per unit — a board without a completed log doesn't get integrated. Link this page from the board's design page so it isn't an orphan.\n\n| Unit | Date | By | Result |\n| --- | --- | --- | --- |\n| *#2* | *2026-08-14* | *MR* | *pass — 31 mA idle (exp 28), 5 V ripple 22 mV, hottest FET 61 °C* |\n\n## Unit #_\n\n- [ ] Visual under the microscope — bridges, tombstones, missing parts, solder balls under QFNs\n- [ ] Shorts: continuity every rail → GND, before any power\n- [ ] First power: bench supply, limit 50 mA over expected idle, no loads — idle measured:\n- [ ] Rails: regulation + ripple at every test point — worst ripple:\n- [ ] Comms: SWD first, then every bus per [[Wiring and Connectors]]\n- [ ] Load: rail-by-rail to 120% of rating — hottest part:\n- [ ] Firmware smoke test: blink, watchdog, telemetry heartbeat\n- [ ] Silk "bring-up by ___" box filled in — paint pen, initials, date\n\nWrite numbers, not "ok" — the next unit gets compared against yours. Anything surprising goes in a \`::: warn\` callout on this page, not in Slack. Copy the section above for each additional unit.\n` },
  { id: 'procedure', name: 'Procedure', desc: 'Steps with pass criteria', body: `Who this applies to and when — one line. If there's a hard rule in here, say it in the first sentence.\n\n::: note Master copy\nDon't tick boxes on this page. Copy the list into the page you're actually working on (••• → Duplicate) and check them there, so the record lives with the thing you did.\n\n:::\n\n## Roles\n\nWho does what while this runs — and who can stop it. Name the role, not the person.\n\n## Before you start\n\n- [ ] Precondition — and how you check it, not just that you should\n- [ ] Precondition — and how you check it, not just that you should\n\n## Steps\n\n1. **Step** — what you do, and the number or state that tells you it worked\n2. **Step** — what you do, and the number or state that tells you it worked\n\n## After\n\n- [ ] Where the result gets written down, and by when\n- [ ] Link this page from wherever it applies, so people find it before they need it\n\n::: warn Why this rule exists\nThe incident behind the strictest step above. Rules without stories get skipped by whoever wasn't there.\n\n:::\n` },
];

const REACTION_SET = [
  ['👍', 'Thumbs up'], ['🎉', 'Celebrate'], ['❤️', 'Love'], ['🚀', 'Ship it'],
  ['👀', 'Looking at this'], ['✅', 'Approved'], ['🦀', 'Crab'], ['😂', 'Funny'],
];

const SECTIONS = [
  { id: 'getting-started', name: 'Getting Started' },
  { id: 'projects', name: 'Projects' },
  { id: 'mechanical', name: 'Mechanical' },
  { id: 'electrical', name: 'Electrical' },
  { id: 'software', name: 'Software' },
  { id: 'operations', name: 'Operations' },
];

// Older revisions with body:null mean "previous body is close enough" — resolved
// at seed time so diffs are real without tripling this file's size.
