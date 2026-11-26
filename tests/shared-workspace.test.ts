import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acknowledgeSource, beginRepositorySave, cancelRepositorySave, createWorkspace, inspectIncoming, isSharedWorkspace, offerWorkspace, pairDocument, pruneReplicas, receiveChanges, registerReplica, renameWorkspace, resumeReplica, saveReviewDrafts, saveWorkspace, startRepositorySave, workspaceSource } from '../integrations/workspace/model.ts';
import { figmaBundle } from '../integrations/figma/projection.ts';
import { openWorkspace } from '../lib/workspace.ts';
import { RepositoryConflicts } from '../lib/repository-merge.ts';
import type { TokenProposal } from '../integrations/figma/contract.ts';
import { identifySubmission } from '../integrations/figma/submission.ts';
import { cubicFromPoints, isCubicEasing } from '../integrations/figma/easing.ts';

const files = (space = 8, other = 16) => [{ path: 'tokens/source.tokens.json', text: '\uFEFF{\r\n  "space": {"$type":"number", "$value":' + space + '},\r\n  "other": {"$type":"number", "$value":' + other + '},\r\n  "alias": {"$type":"number", "$value":"{space}"},\r\n  "$extensions": {"example":{"keep":"å"}}\r\n}\r\n' }];
const input = (space = 8, other = 16) => ({ name: 'Shared work', files: files(space, other), baseline: files() });
const aliasSources = (a: boolean, b: string | number) => [{ path: 'tokens/base.json', text: JSON.stringify({
  ...(a ? { a: { $type: 'number', $value: 8 } } : {}), b: { $type: 'number', $value: b }, c: { $type: 'number', $value: 16 },
}) }];
const proposal = (revision: string, path = 'space', before = 8, after = 12): TokenProposal => ({ schemaVersion: 1, sourceRevision: revision, changes: [{ path, before, after }] });

await test('shared easing conflicts retain coordinate drafts and resolve to exact source bytes with an idempotent native receipt', async () => {
  const text = '\uFEFF{\r\n "curve":{"$type":"cubicBezier","$value":[1.23456789e-1, -0.125, 0.876543211, 1.125],"$description":"overshoot"},\r\n "alias":{"$type":"cubicBezier","$value":"{curve}"}\r\n}\r\n';
  const sources = [{ path: 'easing.json', text }]; const original = { name: 'Easing', files: sources, baseline: sources };
  let state = pairDocument(await createWorkspace('a'.repeat(64), original), { id: 'library', name: 'Library', role: 'library' });
  const baseline = state.draft; const points = [0.123456789, -0.125, 0.876543211, 1.125];
  state = await saveWorkspace(state, baseline, { ...original, files: [{ path: 'easing.json', text: text.replace('-0.125', '-0.5') }] });
  const native = await identifySubmission({ schemaVersion: 1, sourceRevision: baseline, changes: [{ path: 'curve', before: points, after: [0.123456789, -0.25, 0.876543211, 1.125] }] }, '', state.id);
  const pending = await receiveChanges(state, 'library', native); assert(!pending.accepted); assert.equal(pending.conflicts.length, 1);
  const draft = { path: 'curve', keep: 'custom', inputKind: 'value' as const, text: '["0.123456789","-",0.876543211,1.125]' };
  state = await saveReviewDrafts(pending.state, 'library', pending.state.draft, [draft]);
  const restored = structuredClone(state); assert(isSharedWorkspace(restored));
  assert.deepEqual((await inspectIncoming(restored, 'library')).drafts, [draft]);
  const custom = cubicFromPoints([0.123456789, -0.75, 0.876543211, 1.125]); assert(custom);
  const accepted = await receiveChanges(restored, 'library', native, [{ path: 'curve', value: custom }], restored.draft);
  assert(accepted.accepted && accepted.acknowledgement && accepted.bundle);
  assert.equal(workspaceSource(accepted.state).files[0]?.text, text.replace('-0.125', '-0.75'));
  assert.equal(accepted.bundle.variables.find(row => row.path === 'alias')?.alias, 'curve');
  assert(isCubicEasing(accepted.acknowledgement.values.find(row => row.path === 'curve')?.value));
  const retry = await receiveChanges(structuredClone(accepted.state), 'library', native);
  assert(retry.accepted); assert.deepEqual(retry.state, accepted.state); assert.deepEqual(retry.acknowledgement, accepted.acknowledgement);
});

await test('shared native dimension edits and restoration retain inline source bytes through receipt rebasing', async () => {
  const text = '{"reference":{"space":{"medium":{"$type":"dimension","$value":{"value":16,"unit":"px"}}}}}\n';
  const sources = [{ path: 'tokens/reference.tokens.json', text }];
  let state = pairDocument(await createWorkspace('a'.repeat(64), { name: 'Inline', files: sources, baseline: sources }), { id: 'library', name: 'Library', role: 'library' });
  const original = state.draft;
  const changes: TokenProposal = { schemaVersion: 1, sourceRevision: original, changes: [{ path: 'reference.space.medium', before: { value: 16, unit: 'px' }, after: { value: 18, unit: 'px' } }] };
  const edited = await receiveChanges(state, 'library', changes); assert(edited.accepted && edited.bundle);
  state = acknowledgeSource(edited.state, 'library', edited.bundle.revision);
  assert.equal(workspaceSource(state).files[0]?.text, text.replace('"value":16', '"value":18'));
  const restored = await receiveChanges(state, 'library', { ...changes, sourceRevision: state.draft, changes: [{ path: 'reference.space.medium', before: { value: 18, unit: 'px' }, after: { value: 16, unit: 'px' } }] });
  assert(restored.accepted); assert.equal(workspaceSource(restored.state).files[0]?.text, text); assert.equal(restored.state.draft, original);
});

await test('resume accepts a known snapshot saved by another device, rejects foreign source and retains an older queued review', async () => {
  const one = '1'.repeat(64); const two = '2'.repeat(64);
  let state = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const original = state.draft;
  state = registerReplica(registerReplica(state, 'library', one), 'library', two);
  const first = await receiveChanges(state, 'library', proposal(original), undefined, undefined, one);
  const acceptedRevision = first.state.draft;
  state = await saveWorkspace(first.state, acceptedRevision, input(16));
  const pending = await receiveChanges(state, 'library', proposal(original, 'space', 8, 14), undefined, undefined, two);
  assert.equal(pending.accepted, false);
  state = resumeReplica(pending.state, 'library', two, acceptedRevision);
  assert.equal(state.replicas?.find(item => item.id === two)?.baseline, acceptedRevision);
  assert.throws(() => resumeReplica(state, 'library', two, 'f'.repeat(64)), /source revision is unavailable/u);
  const resolved = await receiveChanges(state, 'library', proposal(original, 'space', 8, 14), [{ path: 'space', value: 14 }], state.draft, two);
  assert(resolved.accepted); assert.equal(resolved.bundle?.variables.find(row => row.path === 'space')?.value, 14);
  state = resumeReplica(resolved.state, 'library', one, resolved.state.draft);
  const independent = await receiveChanges(state, 'library', proposal(state.draft, 'other', 16, 20), undefined, undefined, one);
  assert(independent.accepted); assert.equal(independent.bundle?.variables.find(row => row.path === 'other')?.value, 20);
});

await test('modern devices can continue from another device snapshot and its consumed receipt in the same file', async () => {
  const one = '1'.repeat(64); const two = '2'.repeat(64);
  let state = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const original = state.draft; state = registerReplica(registerReplica(state, 'library', one), 'library', two);
  const first = await receiveChanges(state, 'library', await identifySubmission(proposal(original), '', state.id), undefined, undefined, one);
  assert(first.accepted && first.acknowledgement);
  state = resumeReplica(first.state, 'library', two, first.state.draft, first.acknowledgement.id);
  const second = await receiveChanges(state, 'library', await identifySubmission(proposal(state.draft, 'other', 16, 20), first.acknowledgement.id, state.id), undefined, undefined, two);
  assert(second.accepted && second.acknowledgement);
  state = resumeReplica(second.state, 'library', one, second.state.draft, second.acknowledgement.id);
  const fresh = await identifySubmission(proposal(state.draft, 'space', 12, 14), second.acknowledgement.id, state.id);
  const third = await receiveChanges(state, 'library', fresh, undefined, undefined, one);
  assert(third.accepted); assert.equal(third.bundle?.variables.find(row => row.path === 'space')?.value, 14);
  assert.equal(third.bundle?.variables.find(row => row.path === 'other')?.value, 20);
  assert.equal(third.state.replicas?.find(item => item.id === one)?.consumedReceipt, undefined);
  assert.throws(() => resumeReplica(third.state, 'library', one, third.state.draft, 'unknown-receipt'), /acknowledgement is unavailable/u);
});

await test('two devices in one Figma file retain independent offers, acknowledgements, receipts and conflicting edits', async () => {
  const one = '1'.repeat(64); const two = '2'.repeat(64);
  let state = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const original = state.draft;
  state = registerReplica(registerReplica(state, 'library', one), 'library', two);
  const first = await receiveChanges(state, 'library', proposal(original), undefined, undefined, one); assert(first.accepted && first.acknowledgement);
  const receipt = first.acknowledgement.id;
  const offeredTwo = await offerWorkspace(first.state, 'library', two); const olderOffer = offeredTwo.bundle.revision;
  state = await saveWorkspace(offeredTwo.state, offeredTwo.state.draft, input(12, 20));
  const offeredOne = await offerWorkspace(state, 'library', one);
  state = acknowledgeSource(offeredOne.state, 'library', offeredOne.bundle.revision, one);
  state = acknowledgeSource(state, 'library', olderOffer, two);
  assert.equal(workspaceSource(state, olderOffer).revision, olderOffer, 'Another device cannot prune or overwrite this offered snapshot.');
  assert.equal(state.replicas?.find(item => item.id === one)?.receipt?.id, receipt);
  assert.equal(state.replicas?.find(item => item.id === two)?.receipt, undefined);
  const pending = await receiveChanges(state, 'library', proposal(olderOffer, 'other', 16, 24), undefined, undefined, two); assert.equal(pending.accepted, false);
  const later = await receiveChanges(pending.state, 'library', proposal(offeredOne.bundle.revision, 'space', 12, 14), undefined, undefined, one); assert(later.accepted);
  const reviewed = await inspectIncoming(later.state, 'library', two); assert.equal(reviewed.conflicts[0]?.path, 'other');
  state = await saveReviewDrafts(later.state, 'library', later.state.draft, [{ path: 'other', keep: 'custom', text: '24' }], two);
  assert.deepEqual((await inspectIncoming(structuredClone(state), 'library', two)).drafts, [{ path: 'other', keep: 'custom', text: '24' }]);
  const resolved = await receiveChanges(state, 'library', proposal(olderOffer, 'other', 16, 24), [{ path: 'other', value: 24 }], state.draft, two); assert(resolved.accepted);
  const bundle = await figmaBundle(openWorkspace(state.name, workspaceSource(resolved.state).files));
  assert.equal(bundle.variables.find(row => row.path === 'space')?.value, 14); assert.equal(bundle.variables.find(row => row.path === 'other')?.value, 24);
  assert.equal(resolved.state.replicas?.find(item => item.id === one)?.receipt?.id, later.acknowledgement?.id);
  assert.notEqual(resolved.acknowledgement?.id, later.acknowledgement?.id);
  assert(isSharedWorkspace(structuredClone(resolved.state)));
});

await test('legacy file receipts and queued choices migrate to one device, and revocation retains a review until it is resolved', async () => {
  const one = '1'.repeat(64); const two = '2'.repeat(64);
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const accepted = await receiveChanges(initial, 'library', proposal(initial.draft)); assert(accepted.accepted && accepted.acknowledgement);
  const remote = await saveWorkspace(accepted.state, accepted.state.draft, input(16));
  const incoming = proposal(initial.draft, 'space', 8, 14);
  const queued = await receiveChanges(remote, 'library', incoming); assert.equal(queued.accepted, false);
  let state = registerReplica(queued.state, 'library', one, true); state = registerReplica(state, 'library', two);
  assert.equal(state.replicas?.find(item => item.id === one)?.receipt?.id, accepted.acknowledgement.id);
  assert.equal(state.replicas?.find(item => item.id === two)?.receipt, undefined);
  assert.equal(state.incoming[0]?.replica, one);
  state = pruneReplicas(state, new Set([two])); assert(state.replicas?.some(item => item.id === one), 'A revoked device keeps its queued review and source baseline.');
  const resolved = await receiveChanges(state, 'library', incoming, [{ path: 'space', value: 14 }], state.draft, one); assert(resolved.accepted);
  state = pruneReplicas(resolved.state, new Set([two])); assert.equal(state.replicas?.some(item => item.id === one), false);
  assert.equal(state.replicas?.find(item => item.id === two)?.baseline, remote.draft);
  assert.equal((await figmaBundle(openWorkspace(state.name, workspaceSource(state).files))).variables.find(row => row.path === 'space')?.value, 14);
});

await test('a reviewed save can be cancelled before its first write and cannot be discarded after a write may have started', async () => {
  const initial = await createWorkspace('a'.repeat(64), { ...input(12), repository: { repository: 'org/tokens', root: 'tokens', revision: '1'.repeat(40) } });
  assert(initial.repository);
  const request = { repository: 'org/tokens', revision: '1'.repeat(40), changes: [{ path: 'tokens/source.tokens.json', before: files()[0]?.text ?? '', after: files(12)[0]?.text ?? '' }] };
  const prepared = await beginRepositorySave(initial, request, 'tokens'); const operation = prepared.repositorySave; assert(operation);
  const cancelled = cancelRepositorySave(prepared, operation.id); assert.equal(cancelled.repositorySave, undefined); assert.equal(cancelled.draft, prepared.draft); assert.equal(cancelled.baseline, prepared.baseline);
  assert.throws(() => startRepositorySave(cancelled, operation.id), /cancelled or completed/u);
  const started = startRepositorySave(prepared, operation.id);
  assert.equal(started.repositorySave?.started, true);
  assert.throws(() => cancelRepositorySave(started, operation.id), /write may have started/u);
  await assert.rejects(saveWorkspace(started, started.draft, { ...input(12), baseline: files(12), repository: initial.repository }), /Finish the interrupted/u);
});

await test('a stale source save cannot undo an explicit workspace name and concurrent names require a choice', async () => {
  const original = await createWorkspace('a'.repeat(64), input());
  const renamed = renameWorkspace(original, original.name, 'Spacing exploration');
  const saved = await saveWorkspace(renamed, original.draft, input(12));
  assert.equal(saved.name, 'Spacing exploration'); assert.equal(saved.baseline, original.baseline);
  assert.equal(renameWorkspace(saved, original.name, 'Spacing exploration'), saved);
  assert.throws(() => renameWorkspace(saved, original.name, 'Another draft'), /renamed in another client/u);
});

await test('an interrupted offered snapshot remains available until native recovery acknowledges it before fetching newer source', async () => {
  const initial = await createWorkspace('a'.repeat(64), input());
  const paired = pairDocument(initial, { id: 'library', name: 'Library', role: 'library' });
  const edited = await saveWorkspace(paired, paired.draft, input(10));
  const offered = await offerWorkspace(edited, 'library');
  const newer = await saveWorkspace(offered.state, offered.state.draft, input(14));
  assert.equal(workspaceSource(newer, offered.bundle.revision).revision, offered.bundle.revision);
  const acknowledged = acknowledgeSource(newer, 'library', offered.bundle.revision);
  const latest = await offerWorkspace(acknowledged, 'library');
  const result = await receiveChanges(latest.state, 'library', proposal(offered.bundle.revision, 'space', 10, 12));
  assert.equal(result.accepted, false); assert.equal(result.conflicts[0]?.before, 10); assert.equal(result.conflicts[0]?.local, 12); assert.equal(result.conflicts[0]?.remote, 14);
});

await test('a second native edit before receiving a receipt follows its submitted edit while another author still conflicts', async () => {
  const initial = await createWorkspace('a'.repeat(64), input());
  const paired = pairDocument(initial, { id: 'library', name: 'Library', role: 'library' });
  const first = await receiveChanges(paired, 'library', proposal(initial.draft));
  const second = await receiveChanges(first.state, 'library', proposal(initial.draft, 'space', 8, 14));
  assert.equal(second.accepted, true); assert.equal(second.bundle?.variables.find(row => row.path === 'space')?.value, 14);
  const other = await saveWorkspace(first.state, first.state.draft, input(16));
  const conflict = await receiveChanges(other, 'library', proposal(initial.draft, 'space', 8, 14));
  assert.equal(conflict.accepted, false); assert.equal(conflict.state.incoming.length, 1);
});

await test('unfinished conflict forms are durable, revision checked and cannot change a linked file role silently', async () => {
  const initial = await createWorkspace('a'.repeat(64), input());
  const paired = pairDocument(initial, { id: 'library', name: 'Library', role: 'library' });
  assert.throws(() => pairDocument(paired, { id: 'library', name: 'Concept', role: 'concept' }), /existing role/u);
  const edited = await saveWorkspace(paired, paired.draft, input(10));
  const pending = await receiveChanges(edited, 'library', proposal(initial.draft));
  const drafts = [{ path: 'space', keep: 'custom', text: 'unfinished' }];
  const saved = await saveReviewDrafts(pending.state, 'library', edited.draft, drafts);
  assert.deepEqual((await inspectIncoming(structuredClone(saved), 'library')).drafts, drafts);
  await assert.rejects(saveReviewDrafts(saved, 'library', initial.draft, drafts), /workspace changed/u);
  await assert.rejects(saveReviewDrafts(saved, 'library', saved.draft, [...drafts, ...drafts]), /choices do not match/u);
  const newer = await saveWorkspace(saved, saved.draft, input(10, 18));
  assert.deepEqual((await inspectIncoming(newer, 'library')).drafts, drafts);
});

await test('a persistent workspace owns exact draft and repository baseline independently of its Figma documents', async () => {
  const initial = await createWorkspace('a'.repeat(64), input());
  assert(isSharedWorkspace(structuredClone(initial)));
  const paired = pairDocument(initial, { id: 'library-file', name: 'UI kit', role: 'library' });
  const edited = await saveWorkspace(paired, paired.draft, input(10));
  assert.equal(workspaceSource(edited).files[0]?.text, files(10)[0]?.text);
  assert.equal(workspaceSource(edited, edited.baseline).files[0]?.text, files()[0]?.text);
  assert.equal(edited.documents[0]?.baseline, initial.draft);
  assert.equal(edited.version, 3);
  assert.equal(JSON.stringify(edited).includes('connection'), false);
  assert.equal((await saveWorkspace(edited, edited.draft, input(10))), edited);
});

await test('independent changes from two Figma files share one draft and each gets its own acknowledgement', async () => {
  let state = await createWorkspace('a'.repeat(64), input());
  state = pairDocument(pairDocument(state, { id: 'one', name: 'Library one', role: 'library' }), { id: 'two', name: 'Library two', role: 'library' });
  const original = state.draft;
  const first = await receiveChanges(state, 'one', proposal(original)); assert(first.accepted);
  const second = await receiveChanges(first.state, 'two', proposal(original, 'other', 16, 20)); assert(second.accepted);
  const bundle = await figmaBundle(openWorkspace(second.state.name, workspaceSource(second.state).files));
  assert.equal(bundle.variables.find(row => row.path === 'space')?.value, 12);
  assert.equal(bundle.variables.find(row => row.path === 'other')?.value, 20);
  assert.equal(bundle.variables.find(row => row.path === 'alias')?.alias, 'space');
  assert.deepEqual(second.acknowledgement?.values, [{ path: 'other', value: 20 }]);
  assert.equal(second.state.documents.find(file => file.id === 'one')?.receipt?.values[0]?.value, 12);
});

await test('a true conflict remains queued across serialization and resolves against the current workspace revision', async () => {
  let state = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const original = state.draft;
  state = await saveWorkspace(state, original, input(10));
  const conflict = await receiveChanges(state, 'library', proposal(original));
  assert.equal(conflict.accepted, false); assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.state.draft, state.draft); assert.equal(conflict.state.incoming.length, 1);
  const restored = structuredClone(conflict.state); assert(isSharedWorkspace(restored));
  const changedAgain = await saveWorkspace(restored, restored.draft, input(11));
  await assert.rejects(receiveChanges(changedAgain, 'library', proposal(original), [{ path: 'space', value: 12 }], restored.draft), /changed during this review/u);
  const resolved = await receiveChanges(restored, 'library', proposal(original), [{ path: 'space', value: 14 }], restored.draft);
  assert(resolved.accepted); assert.equal(resolved.state.incoming.length, 0);
  assert.equal(resolved.bundle?.variables.find(row => row.path === 'space')?.value, 14);
  assert.deepEqual(resolved.acknowledgement?.values, [{ path: 'space', value: 12 }]);
});

await test('unfinished conflict input survives later shared edits while stale submissions remain rejected', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const remote = await saveWorkspace(initial, initial.draft, input(10));
  const queued = await receiveChanges(remote, 'library', proposal(initial.draft));
  const drafts = [{ path: 'space', keep: 'custom', text: 'unfinished-conflict' }];
  const reviewed = await saveReviewDrafts(queued.state, 'library', queued.state.draft, drafts);
  await Promise.all([{ next: input(11), alias: 11 }, { next: input(10, 20), alias: 10 }].map(async ({ next, alias }) => {
    const changed = await saveWorkspace(structuredClone(reviewed), reviewed.draft, next);
    const review = await inspectIncoming(changed, 'library');
    assert.deepEqual(review.drafts, drafts, 'A new source revision must not hide unfinished input.');
    assert.equal(review.reviewChanged, true);
    assert.equal(review.current.revision, changed.draft);
    await assert.rejects(saveReviewDrafts(changed, 'library', reviewed.draft, []), /changed/u);
    await assert.rejects(receiveChanges(changed, 'library', proposal(initial.draft), [{ path: 'space', value: 14 }], reviewed.draft), /changed during/u);
    assert.deepEqual((await inspectIncoming(changed, 'library')).drafts, drafts);
    assert.equal(openWorkspace(changed.name, workspaceSource(changed).files).graph.resolved.get('alias'), alias);
  }));
});

await test('a conflict that converges retains earlier input until it is explicitly discarded', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const remote = await saveWorkspace(initial, initial.draft, input(10));
  const queued = await receiveChanges(remote, 'library', proposal(initial.draft));
  const drafts = [{ path: 'space', keep: 'custom', text: '14' }];
  const reviewed = await saveReviewDrafts(queued.state, 'library', queued.state.draft, drafts);
  const converged = await saveWorkspace(reviewed, reviewed.draft, input(12));
  const review = await inspectIncoming(converged, 'library');
  assert.equal(review.conflicts.length, 0); assert.deepEqual(review.drafts, drafts);
  const retry = await receiveChanges(converged, 'library', proposal(initial.draft));
  assert.equal(retry.accepted, false); assert.deepEqual(retry.drafts, drafts);
  await assert.rejects(receiveChanges(converged, 'library', proposal(initial.draft), [], converged.draft), /retained input/u);
  const kept = await saveReviewDrafts(converged, 'library', converged.draft, drafts);
  assert.deepEqual((await inspectIncoming(kept, 'library')).drafts, drafts);
  const cleared = await saveReviewDrafts(kept, 'library', kept.draft, []);
  const accepted = await receiveChanges(cleared, 'library', proposal(initial.draft), [], cleared.draft);
  assert(accepted.accepted); assert.equal(accepted.state.incoming.length, 0);
  assert.equal(accepted.state.draft, converged.draft);
});

await test('retrying a stored native submission is idempotent even after its source acknowledgement', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const sent = proposal(initial.draft);
  const accepted = await receiveChanges(initial, 'library', sent); assert(accepted.accepted);
  const offered = await offerWorkspace(accepted.state, 'library');
  const acknowledged = acknowledgeSource(offered.state, 'library', offered.bundle.revision);
  const retry = await receiveChanges(acknowledged, 'library', sent);
  assert.equal(retry.state, acknowledged); assert.equal(retry.acknowledgement?.id, accepted.acknowledgement?.id);
});

await test('a new identical Figma edit after a browser reversion is distinct from retrying the accepted submission', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const first = await identifySubmission(proposal(initial.draft), '', initial.id);
  const accepted = await receiveChanges(initial, 'library', first); assert(accepted.accepted && accepted.acknowledgement);
  const reverted = await saveWorkspace(acknowledgeSource(accepted.state, 'library', accepted.state.draft), accepted.state.draft, input());
  const offered = await offerWorkspace(reverted, 'library');
  const acknowledged = acknowledgeSource(offered.state, 'library', offered.bundle.revision);
  const retry = await receiveChanges(acknowledged, 'library', first);
  assert.equal(retry.state, acknowledged); assert.deepEqual(workspaceSource(retry.state).files, files());
  const fresh = await identifySubmission(proposal(initial.draft), accepted.acknowledgement.id, initial.id);
  assert.notEqual(fresh.submissionId, first.submissionId);
  const repeated = await receiveChanges(acknowledged, 'library', fresh);
  assert(repeated.accepted); assert.deepEqual(workspaceSource(repeated.state).files, files(12));
});

await test('fresh submission conflicts use the read baseline and later unacknowledged edits use their accepted predecessor', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const first = await identifySubmission(proposal(initial.draft), '', initial.id);
  const accepted = await receiveChanges(initial, 'library', first); assert(accepted.accepted && accepted.acknowledgement);
  const remote = await saveWorkspace(accepted.state, accepted.state.draft, input(13));
  const later = await identifySubmission(proposal(initial.draft, 'space', 8, 14), '', initial.id);
  const concurrent = await receiveChanges(remote, 'library', later);
  assert.equal(concurrent.accepted, false); assert.deepEqual(concurrent.conflicts, [{ path: 'space', before: 12, local: 14, remote: 13 }]);
  const read = await offerWorkspace(accepted.state, 'library');
  const restored = await saveWorkspace(acknowledgeSource(read.state, 'library', read.bundle.revision), read.state.draft, input());
  const offered = await offerWorkspace(restored, 'library');
  const current = acknowledgeSource(offered.state, 'library', offered.bundle.revision);
  const changed = await saveWorkspace(current, current.draft, input(10));
  const fresh = await identifySubmission(proposal(initial.draft), accepted.acknowledgement.id, initial.id);
  const pending = await receiveChanges(changed, 'library', fresh);
  assert.equal(pending.accepted, false); assert.deepEqual(pending.conflicts, [{ path: 'space', before: 8, local: 12, remote: 10 }]);
  assert.deepEqual((await inspectIncoming(pending.state, 'library')).conflicts, pending.conflicts);
});

await test('a delayed older retry cannot replace a newer submission or create another conflict queue', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const first = await identifySubmission(proposal(initial.draft), '', initial.id);
  const accepted = await receiveChanges(initial, 'library', first); assert(accepted.accepted && accepted.acknowledgement);
  const later = await identifySubmission(proposal(initial.draft, 'space', 8, 14), '', initial.id);
  const saved = await receiveChanges(accepted.state, 'library', later); assert(saved.accepted && saved.acknowledgement);
  const remote = await saveWorkspace(saved.state, saved.state.draft, input(16)); const before = structuredClone(remote);
  const replay = await receiveChanges(remote, 'library', first);
  assert.equal(replay.state, remote); assert.deepEqual(replay.state, before); assert.equal(replay.acknowledgement?.id, accepted.acknowledgement.id);
  assert.equal(replay.state.documents[0]?.receipt?.id, saved.acknowledgement.id); assert.equal(replay.state.incoming.length, 0);
});

await test('returning to 12 before acknowledgement is a new intent and an unseen older 14 cannot overwrite it', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const origin = 'd'.repeat(64);
  const native = (after: number, sequence: number) => identifySubmission(proposal(initial.draft, 'space', 8, after), '', initial.id, origin, sequence);
  const first = await native(12, 1); const delayed = await native(14, 2); const returned = await native(12, 3);
  assert.notEqual(first.submissionId, returned.submissionId);
  const accepted = await receiveChanges(initial, 'library', first); assert(accepted.accepted);
  const latest = await receiveChanges(accepted.state, 'library', returned); assert(latest.accepted);
  assert.equal(latest.bundle?.variables.find(row => row.path === 'space')?.value, 12);
  const before = structuredClone(latest.state);
  await assert.rejects(receiveChanges(latest.state, 'library', delayed), /Newer native edits/u);
  assert.deepEqual(latest.state, before);
  const retry = await receiveChanges(latest.state, 'library', first); assert.equal(retry.state, latest.state);
  assert.equal(retry.acknowledgement?.id, accepted.acknowledgement?.id);
});

await test('unacknowledged submission history has a bounded recovery gate and a fresh acknowledgement releases it', async () => {
  const initial = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const full = await Array.from({ length: 16 }, (_, index) => index + 20).reduce(async (previous, value) => {
    const state = await previous; const sent = await identifySubmission(proposal(initial.draft, 'space', 8, value), '', initial.id);
    const result = await receiveChanges(state, 'library', sent); assert(result.accepted); return result.state;
  }, Promise.resolve(initial));
  const before = structuredClone(full); const blocked = await identifySubmission(proposal(initial.draft, 'space', 8, 99), '', initial.id);
  await assert.rejects(receiveChanges(full, 'library', blocked), /latest source acknowledgement/u); assert.deepEqual(full, before);
  const receipt = full.documents[0]?.receipt; assert(receipt);
  const read = acknowledgeSource(full, 'library', full.draft);
  const fresh = await identifySubmission(proposal(full.draft, 'space', 35, 99), receipt.id, initial.id);
  const saved = await receiveChanges(read, 'library', fresh); assert(saved.accepted); assert.equal(saved.state.documents[0]?.submissions?.length, 1);
  const stale = await identifySubmission(proposal(initial.draft, 'space', 8, 20), '', initial.id);
  await assert.rejects(receiveChanges(saved.state, 'library', stale), /predates the current acknowledgement/u);
  await assert.rejects(receiveChanges(saved.state, 'library', proposal(initial.draft)), /updated Foundry plugin/u);
  assert.equal(saved.state.incoming.length, 0); assert.deepEqual(workspaceSource(saved.state).files, files(99));
});

await test('a concept file can read updates but cannot edit shared token definitions', async () => {
  const state = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'concept', name: 'Concept', role: 'concept' });
  assert.equal((await offerWorkspace(state, 'concept')).bundle.variables.length, 3);
  await assert.rejects(receiveChanges(state, 'concept', proposal(state.draft)), /linked library file/u);
  assert.throws(() => acknowledgeSource(state, 'concept', 'b'.repeat(64)), /does not match/u);
});

await test('stale browser changes merge independent definitions and retain a conflicting draft for explicit review', async () => {
  const original = await createWorkspace('a'.repeat(64), input());
  const remote = await saveWorkspace(original, original.draft, input(12));
  const independent = await saveWorkspace(remote, original.draft, input(8, 20));
  const graph = openWorkspace(independent.name, workspaceSource(independent).files).graph;
  assert.equal(graph.resolved.get('space'), 12); assert.equal(graph.resolved.get('other'), 20);
  await assert.rejects(saveWorkspace(remote, original.draft, input(10)), RepositoryConflicts);
  assert.equal(workspaceSource(remote).files[0]?.text, files(12)[0]?.text);
});

await test('the shared store rejects invalid reference interactions from a stale writer before mutating its source', async () => {
  const initial = { name: 'Aliases', files: aliasSources(true, 12), baseline: aliasSources(true, 12) };
  const original = await createWorkspace('a'.repeat(64), initial);
  const remote = await saveWorkspace(original, original.draft, { ...initial, files: aliasSources(false, 12) });
  const before = structuredClone(remote);
  await assert.rejects(saveWorkspace(remote, original.draft, { ...initial, files: aliasSources(true, '{a}') }), /a/u);
  assert.deepEqual(remote, before);
  const repaired = await saveWorkspace(remote, original.draft, { ...initial, files: aliasSources(true, '{c}') });
  assert.deepEqual(workspaceSource(repaired).files, aliasSources(false, '{c}'));
});

await test('malformed source is recoverable while invalid paths and invalid native edits never mutate the accepted draft', async () => {
  const broken = [{ path: 'tokens/broken.json', text: '{"unfinished":' }];
  const state = await createWorkspace('a'.repeat(64), { name: 'Repair', files: broken, baseline: broken });
  assert.equal(workspaceSource(state).files[0]?.text, broken[0]?.text);
  await assert.rejects(createWorkspace('a'.repeat(64), { ...input(), files: [{ path: '../escape.json', text: '{}' }] }), /Invalid/u);
  const paired = pairDocument(await createWorkspace('a'.repeat(64), input()), { id: 'library', name: 'Library', role: 'library' });
  const invalid: TokenProposal = { schemaVersion: 1, sourceRevision: paired.draft, changes: [{ path: 'space', before: 8, after: '{alias}' }] };
  await assert.rejects(receiveChanges(paired, 'library', invalid), /circular|cycle/iu);
  assert.equal(workspaceSource(paired).files[0]?.text, files()[0]?.text);
});
