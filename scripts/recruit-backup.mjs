// A complete cycle snapshot for recovery, including all forms, shared reviews,
// response metadata and referenced attachment bytes. Called before legacy rollback.
import { writeFile } from 'node:fs/promises';
export async function backupCycle(sql, cycleId, path) {
  if (!path) throw new Error('Choose a backup path');
  const read = async (s) => {
    const cycle = (await s`SELECT * FROM recruit_cycles WHERE id = ${cycleId}`).rows[0];
    if (!cycle) throw new Error('No such cycle');
    const applications = (await s`SELECT * FROM recruit_applications WHERE cycle_id = ${cycleId} ORDER BY ts, id`).rows;
    const emails = [...new Set(applications.map((a) => a.email))];
    const applicants = emails.length ? (await s`SELECT * FROM recruit_applicants WHERE email = ANY(${emails})`).rows : [];
    const settings = (await s`SELECT * FROM recruit_settings WHERE id = 1`).rows[0] || null;
    const people = (await s`SELECT * FROM recruit_people WHERE cycle_id = ${cycleId}`).rows;
    const roles = (await s`SELECT * FROM recruit_roles WHERE cycle_id = ${cycleId}`).rows;
    const audit = (await s`SELECT * FROM recruit_audit WHERE cycle_id = ${cycleId}`).rows;
    const ids = [...new Set(applications.flatMap((a) => (a.files || []).map((f) => f.id)))];
    const files = ids.length ? (await s`SELECT id, name, type, size, by, ts, encode(data, 'base64') AS data_base64 FROM wiki_files WHERE id = ANY(${ids})`).rows : [];
    const receipts = applications.map((a) => a.receipt_id).filter(Boolean);
    const outcomes = receipts.length ? (await s`SELECT * FROM interest_receipts WHERE id = ANY(${receipts})`).rows : [];
    return { format: 'cupi-recruit-cycle', version: 1, createdAt: new Date().toISOString(), cycle, settings, applications, applicants, people, roles, audit, files, outcomes };
  };
  const snapshot = sql.transaction ? await sql.transaction(async (s) => { await s`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; return read(s); }) : await read(sql);
  // Refuse overwriting another backup and restrict local access to its owner.
  await writeFile(path, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
  return { path, applications: snapshot.applications.length, people: snapshot.people.length, files: snapshot.files.length };
}
