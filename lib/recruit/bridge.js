// The intake bridge: what lib/interest.js calls (as ctx.intake) at its five
// seam points. Every method answers in the legacy shape so interest.js's
// responses, notify() and the legacy admin panel stay byte-for-byte what
// they are today. Any thrown error makes interest.js fall back to its own
// tables, so this file never needs to be defensive about the caller.

import { sectionsFor } from './sections.js';

export function createIntakeBridge(kit) {
  const legacy = (app) => (app ? kit.apps.toLegacyRow(app) : null);

  const bridge = {
    // The cycle receiving the website form right now, or null.
    async target() {
      const t = await kit.cycles.intakeTarget();
      if (!t) return null;
      let closed = false;
      try { const cycle = await kit.cycles.get(t.cycleId); closed = Boolean(cycle) && !sectionsFor(cycle).interest.open; } catch (e) { closed = false; }
      return {
        cycleId: t.cycleId, section: 'interest', closed, formVersion: t.formVersion, perIpHour: t.perIpHour, perDay: t.perDay,
        capacity: t.capacity, notify: t.notify, confirmUpdate: t.confirmUpdate,
      };
    },

    async find(target, email) {
      return legacy(await kit.apps.findByEmail(target.cycleId, String(email || '').toLowerCase(), 'interest'));
    },

    async count(target) {
      return kit.apps.count(target.cycleId, 'interest');
    },

    // One durable write (file first, then the commit statement) and, for a
    // brand-new application, the audit row and the application.created event.
    async commit(entry, journal, file, target) {
      const cycle = await kit.cycles.get(target.cycleId);
      if (!cycle) throw new Error('No such cycle');
      const intake = cycle.doc?.intake || {};
      const result = await kit.apps.commitIntake(cycle, entry, journal, file, {
        confirmUpdate: Boolean(entry.confirmUpdate) && intake.confirmUpdate !== false,
        override: Boolean(target.override),
        source: target.source || (entry.answers ? 'apply' : 'form'),
      });
      if (result.outcome === 'saved' && result.inserted && result.row) {
        try {
          await kit.audit({ kind: 'app.create', cycleId: cycle.id, applicationId: result.row.id, actor: 'applicant', detail: { receipt: entry.id, source: result.row.source || 'form' } });
        } catch (e) { /* the row is durable */ }
        try {
          await kit.emit('application.created', { cycle, application: result.row, source: result.row.source || 'form' });
        } catch (e) { /* hooks never fail an intake */ }
      }
      return {
        outcome: result.outcome, existing: legacy(result.existing), row: legacy(result.row),
        inserted: Boolean(result.inserted), notify: intake.notify !== false,
        cycleId: cycle.id, id: result.row?.id || result.existing?.id || null,
      };
    },

    async has(id) {
      return Boolean(await kit.apps.get(null, id));
    },

    // Legacy review routes delegate here after migration; same messages.
    async review(id, mutation) {
      const out = await kit.apps.updateReview(id, mutation);
      if (out.error) return out;
      const actor = mutation.comment?.by || mutation.flag?.flaggedBy || 'system';
      const kind = mutation.deleteComment ? 'comment.delete' : mutation.comment ? 'comment.post' : 'app.flag';
      try {
        await kit.audit({ kind, cycleId: out.row.cycleId, applicationId: id, actor, detail: mutation.deleteComment ? { commentId: mutation.deleteComment } : mutation.comment ? { commentId: mutation.comment.id } : { flagged: Boolean(mutation.flag?.flagged) } });
      } catch (e) { /* best effort */ }
      return { row: legacy(out.row) };
    },

    async remove(id, by = 'system') {
      const removed = await kit.apps.remove(id, { by });
      return removed ? legacy(removed) : null;
    },

    // The intake cycle (else the migrated interest list) in the legacy shape.
    async listLegacy() {
      const t = await kit.cycles.intakeTarget();
      let cycleId = t?.cycleId || null;
      if (!cycleId) cycleId = (await kit.cycles.get('cy-interest')) ? 'cy-interest' : null;
      if (!cycleId) return { rows: [], truncated: false };
      const out = await kit.apps.legacyRows(cycleId, 1000);
      return { rows: out.rows.map(legacy), truncated: out.truncated };
    },

    async migrated() {
      return kit.cycles.migrated();
    },
  };
  return bridge;
}
