// Pure selection planner. Inputs must come from an authenticated, complete catalogue.
// This module never deletes files, writes a checkpoint, or acknowledges an upload.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORDS = 60000;
const fail = () => { throw Error('Invalid or incomplete selective catalogue'); };
const check = value => { if (!value) fail(); };
const timestamp = value => {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  const time = Date.parse(value); check(Number.isFinite(time) && new Date(time).toISOString() === value); return time;
};
function ids(values) {
  check(Array.isArray(values) && values.length <= MAX_RECORDS);
  check(values.every(x => typeof x === 'string' && UUID.test(x)));
  check(new Set(values).size === values.length); return new Set(values);
}

// A calendar period in UTC, preserving the time of day and clamping Feb 29.
// The caller supplies the clock: tests, previews and all steps of one plan agree.
export function calendarCutoff(now, months = 12) {
  timestamp(now); check(Number.isInteger(months) && months >= 1 && months <= 120);
  const date = new Date(now), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last)); return date.toISOString();
}

export function planSelectiveReplica({records, now, months = 12, pinnedObjects = [],
  localRevisions = [], pendingRevisions = [], maxDownloadBytes = 64 * 1024 * 1024}) {
  check(Array.isArray(records) && records.length <= MAX_RECORDS);
  check(Number.isSafeInteger(maxDownloadBytes) && maxDownloadBytes >= 0);
  const cutoff = calendarCutoff(now, months), cutoffMs = timestamp(cutoff);
  const byRevision = new Map(), byObject = new Map(), children = new Map();
  for (const input of records) {
    check(input && typeof input === 'object');
    const record = structuredClone(input);
    check(UUID.test(record.objectId) && UUID.test(record.revisionId));
    check(['note', 'attachment','folder'].includes(record.kind)); timestamp(record.updatedAt);
    if(Object.hasOwn(record,'deleted'))check(record.deleted===true&&record.kind==='note'&&record.parents.length>0);
    check(Number.isSafeInteger(record.ciphertextBytes) && record.ciphertextBytes > 0);
    check(/^[0-9a-f]{64}$/.test(record.sha256));
    ids(record.parents); ids(record.attachments);
    check(record.parents.length <= 64 && !record.parents.includes(record.revisionId));
    check(record.kind === 'note' || record.attachments.length === 0);
    check(!byRevision.has(record.revisionId)); byRevision.set(record.revisionId, record);
    const revisions = byObject.get(record.objectId) || [];
    revisions.push(record); byObject.set(record.objectId, revisions);
  }
  // All ancestors are described in the small catalogue; their bodies need not be
  // downloaded. Missing ancestry cannot be mistaken for a current unique head.
  const remaining = new Map();
  for (const record of byRevision.values()) {
    remaining.set(record.revisionId, record.parents.length);
    for (const parent of record.parents) {
      const ancestor = byRevision.get(parent);
      check(ancestor && ancestor.objectId === record.objectId && ancestor.kind === record.kind);
      const list = children.get(parent) || []; list.push(record.revisionId); children.set(parent, list);
    }
    for (const objectId of record.attachments) {
      const attachments = byObject.get(objectId);
      check(attachments?.length && attachments.every(r => r.kind === 'attachment'));
    }
  }
  // Iterative cycle detection avoids stack exhaustion on long editing histories.
  const queue = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) || []) {
    remaining.set(child, remaining.get(child) - 1); if (remaining.get(child) === 0) queue.push(child);
  }
  check(queue.length === records.length);
  const pinned = ids(pinnedObjects), local = ids(localRevisions), pending = ids(pendingRevisions);
  for (const id of pinned) check(byObject.get(id)?.every(r => r.kind === 'note'));
  for (const id of [...local, ...pending]) check(byRevision.has(id));
  for (const id of pending) check(local.has(id));
  const heads = new Map();
  for (const [objectId, revisions] of byObject) {
    check(revisions.every(r => r.kind === revisions[0].kind));
    heads.set(objectId, revisions.filter(r => !children.has(r.revisionId)));
  }
  // Retain acquired data and every pending local branch. Aging out is not deletion.
  const selectedObjects = new Set(pinned);
  for (const id of local) selectedObjects.add(byRevision.get(id).objectId);
  for (const [id, versions] of heads) if (versions[0].kind === 'folder'
    || (versions[0].kind === 'note' && versions.some(r => !r.deleted && timestamp(r.updatedAt) >= cutoffMs))) selectedObjects.add(id);
  const selected = new Set(local);
  for (const id of selectedObjects) for (const head of heads.get(id)) selected.add(head.revisionId);
  // Only attachment edges are followed, never links to other notes. Repeated
  // attachment references are deduplicated. Older/pending versions retain media.
  for (const id of [...selected]) for (const objectId of byRevision.get(id).attachments) {
    selectedObjects.add(objectId);
    for (const version of heads.get(objectId)) selected.add(version.revisionId);
  }
  const conflicts = [...selectedObjects].filter(id => heads.get(id).length > 1).sort();
  const downloads = [...selected].filter(id => !local.has(id)).sort().map(id => {
    const r = byRevision.get(id);
    return {objectId: r.objectId, revisionId: id, sha256: r.sha256, ciphertextBytes: r.ciphertextBytes};
  });
  const downloadBytes = downloads.reduce((n, r) => n + r.ciphertextBytes, 0);
  check(Number.isSafeInteger(downloadBytes));
  return {cutoff, selectedRevisions: [...selected].sort(), downloads, downloadBytes,
    withinBudget: downloadBytes <= maxDownloadBytes, conflictingObjects: conflicts,
    pendingRevisions: [...pending].sort(), evictions: [],
    nonConflictingNoteObjects: [...selectedObjects].filter(id => heads.get(id)[0].kind === 'note'
      && !heads.get(id)[0].deleted && !conflicts.includes(id)).sort()};
}
