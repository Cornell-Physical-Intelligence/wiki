// First-boot state for the real deployment: the founding admin and three
// starter pages that teach the team how to use the wiki. No demo people,
// no fabricated content — the team writes the rest.

export function seedState() {
  const now = Date.now();
  const page = (id, section, title, body) => ({
    id, section, title, parent: null, tags: [],
    owner: 'ab3233@cornell.edu', created: now, updated: now, updatedBy: 'ab3233@cornell.edu',
    order: 0, body,
    revs: [{ ts: now, by: 'ab3233@cornell.edu', summary: 'Created page', body }],
  });

  return {
    users: [
      { email: 'ab3233@cornell.edu', name: 'Andre Boufama', role: 'admin', status: 'active', subteam: 'Team Lead', joined: now },
    ],
    pages: [
      page('welcome', 'getting-started', 'Welcome to the CUPI Wiki',
`This is CUPI's internal knowledge base. Everything we learn the hard way — CAD conventions, board bring-up rituals, flight test procedure — gets written down here so the next person doesn't have to relearn it.

::: tip Write it down
If you explain something in Slack twice, it belongs on a wiki page. Press **N** anywhere and pick a template.

:::

## House rules

1. **Pages over threads.** Decisions made in meetings or Slack get captured the same day.
2. **Attach the source.** Screenshots of CAD go next to the Onshape link; schematic PDFs go next to the Altium 365 link.
3. **Date your test data.** A measurement without a date and a setup is a rumor.

Start with [[How to Use This Wiki]], then build out your subteam's section.`),
      page('how-to-wiki', 'getting-started', 'How to Use This Wiki',
`The wiki is plain Markdown with extras built for how a hardware team documents things — the full syntax is in the **Formatting guide** (sidebar footer).

## Link pages together

Type \`[[Page Title]]\` to link a page — the editor autocompletes. Links to pages that don't exist yet render red; clicking one creates the page. Every page lists what links to it at the bottom.

## Pictures, schematics, CAD

Drag any file into the editor, or paste a screenshot:

- **Images and SVGs** embed inline with captions and a lightbox
- **STL / OBJ** get an interactive 3D viewer right in the page
- **STEP, SchDoc, PcbDoc, PDF** attach as labeled file cards
- An **Onshape** or **Altium 365** URL pasted on its own line becomes a rich card

## Templates

**N** opens the new-page dialog: meeting notes, design doc, decision record, BOM, test report, bring-up log.

## History is your safety net

Every save is a revision with a diff, and anything can be restored — edit boldly. Deleted pages sit in Trash for 30 days.`),
      page('onboarding', 'getting-started', 'Onboarding Checklist',
`Work through this top to bottom — your lead signs off at the end. Leads: when an item is stale, fix this page, don't route around it.

## Accounts and access

- [ ] Accept the wiki invite (you did — you're reading this)
- [ ] Join the Slack and post an intro
- [ ] GitHub org access
- [ ] Onshape workspace access (mechanical)
- [ ] Altium 365 workspace access (electrical)

## Lab

- [ ] Shop safety course
- [ ] Card access
- [ ] Read the lab safety rules — LiPo handling especially

## First build weekend

- [ ] Shadow a test session
- [ ] Add yourself to your project page's roster table`),
    ],
    comments: [],
    activity: [{ ts: now, by: 'ab3233@cornell.edu', kind: 'create', pageId: 'welcome' }],
    trash: [],
    prefs: {},
  };
}
