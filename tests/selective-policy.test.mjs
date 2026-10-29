import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarCutoff, planSelectiveReplica} from '../src/selective-policy.mjs';
const now = '2026-10-25T12:00:00.000Z';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (object, revision, options = {}) => ({objectId: uuid(object), revisionId: uuid(revision),
  parents: [], kind: 'note', attachments: [], updatedAt: now, ciphertextBytes: 100,
  sha256: 'a'.repeat(64), ...options});
const plan = (records, options = {}) => planSelectiveReplica({records, now, ...options});

test('one calendar year, inclusive cutoff and leap-day clamp', () => {
  assert.equal(calendarCutoff('2024-02-29T23:10:00.000Z'), '2023-02-28T23:10:00.000Z');
  const cutoff = calendarCutoff(now);
  const p = plan([record(1, 11, {updatedAt: cutoff}), record(2, 22, {updatedAt: '2025-10-25T11:59:59.999Z'})]);
  assert.deepEqual(p.selectedRevisions, [uuid(11)]);
});
test('a recent note includes its old media, deduplicates it, leaves unrelated old data remote', () => {
  const records = [record(1, 11, {attachments: [uuid(3)]}), record(2, 22, {attachments: [uuid(3)]}),
    record(3, 33, {kind: 'attachment', updatedAt: '2001-01-01T00:00:00.000Z'}),
    record(4, 44, {updatedAt: '2000-01-01T00:00:00.000Z'})];
  const p = plan(records);
  assert.deepEqual(p.selectedRevisions, [uuid(11), uuid(22), uuid(33)]); assert.equal(p.downloadBytes, 300);
});
test('pinning an old note fetches it; changing period never emits a deletion', () => {
  const records = [record(1, 11, {updatedAt: '2001-01-01T00:00:00.000Z'})];
  assert.equal(plan(records).downloads.length, 0);
  assert.equal(plan(records, {pinnedObjects: [uuid(1)]}).downloads.length, 1);
  const p = plan(records, {localRevisions: [uuid(11)], months: 1});
  assert.deepEqual(p.selectedRevisions, [uuid(11)]); assert.deepEqual(p.evictions, []);
});
test('metadata ancestry removes old heads without downloading old record bodies', () => {
  const p = plan([record(1, 11), record(1, 12, {parents: [uuid(11)]})]);
  assert.deepEqual(p.selectedRevisions, [uuid(12)]); assert.deepEqual(p.conflictingObjects, []);
});
test('offline local branch and concurrent remote edit both survive; edits block on conflict', () => {
  const records = [record(1, 11), record(1, 12, {parents: [uuid(11)]}), record(1, 13, {parents: [uuid(11)]})];
  const p = plan(records, {localRevisions: [uuid(11), uuid(12)], pendingRevisions: [uuid(12)]});
  assert.deepEqual(p.selectedRevisions, [uuid(11), uuid(12), uuid(13)]);
  assert.deepEqual(p.pendingRevisions, [uuid(12)]); assert.deepEqual(p.conflictingObjects, [uuid(1)]);
  assert.deepEqual(p.nonConflictingNoteObjects, []); assert.deepEqual(p.evictions, []);
});
test('missing dependency, missing parent, foreign parent and cyclic graph fail closed', () => {
  assert.throws(() => plan([record(1, 11, {attachments: [uuid(2)]})]));
  assert.throws(() => plan([record(1, 11, {parents: [uuid(12)]})]));
  assert.throws(() => plan([record(1, 11), record(2, 22, {parents: [uuid(11)]})]));
  assert.throws(() => plan([record(1, 11, {parents: [uuid(12)]}), record(1, 12, {parents: [uuid(11)]})]));
});
test('budget is a preflight decision, never silently truncates a note/media group', () => {
  const p = plan([record(1, 11, {ciphertextBytes: 1000})], {maxDownloadBytes: 999});
  assert.equal(p.withinBudget, false); assert.equal(p.downloadBytes, 1000); assert.equal(p.downloads.length, 1);
});
test('invalid dates, unknown pins, nonlocal outbox, duplicate revisions and malformed hashes reject', () => {
  assert.throws(() => calendarCutoff('2026-02-30T00:00:00.000Z'));
  assert.throws(() => plan([record(1, 11)], {pinnedObjects: [uuid(9)]}));
  assert.throws(() => plan([record(1, 11)], {pendingRevisions: [uuid(11)]}));
  assert.throws(() => plan([record(1, 11), record(1, 11)]));
  assert.throws(() => plan([record(1, 11, {sha256: 'invalid'})]));
});
