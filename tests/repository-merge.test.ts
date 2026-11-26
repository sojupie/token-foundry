import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRepositorySources, RepositoryConflicts, RepositoryReviewChanged, repositoryChoiceKey } from '../lib/repository-merge.ts';
import { openWorkspace, reviewAgainstLatest } from '../lib/workspace.ts';

const file = (text: string) => [{ path: 'tokens/test.json', text }];
function conflicts(base: string, draft: string, repository: string) {
  try { mergeRepositorySources(file(base), file(draft), file(repository)); }
  catch (error) { assert(error instanceof RepositoryConflicts); return error.conflicts; }
  throw new Error('Expected repository conflicts.');
}

await test('repository refresh merges independent same-file token and metadata edits and retains exact authored formatting', () => {
  const base = '\uFEFF{\r\n  "a": {"$type":"number","$value":1,"$description":"original"},\r\n  "b": {"$type":"number","$value":2}\r\n}\r\n';
  const draft = base.replace('"$value":1', '"$value":3');
  const repository = base.replace('"original"', '"Updated remotely"').replace('"$value":2', '"$value":4');
  const result = mergeRepositorySources(file(base), file(draft), file(repository));
  assert.equal(result[0]?.text, draft.replace('"original"', '"Updated remotely"').replace('"$value":2', '"$value":4'));
  assert.equal(mergeRepositorySources(file(base), file(repository), file(repository))[0]?.text, repository);
  const review = reviewAgainstLatest(openWorkspace('Draft', file(draft)), openWorkspace('Repository', file(repository)));
  // That workspace has no edits until its original baseline is supplied.
  assert.equal(review, null);
  const original = openWorkspace('Draft', file(draft)); original.baseline = file(base);
  const merged = reviewAgainstLatest(original, openWorkspace('Repository', file(repository)));
  assert(merged); assert.equal(merged.next.graph.resolved.get('a'), 3); assert.equal(merged.next.graph.resolved.get('b'), 4);
  assert.deepEqual(merged.next.baseline, file(repository));
});

await test('a true token conflict preserves independent changes for draft, repository and custom choices', () => {
  const base = '{"a":{"$type":"number","$value":1},"b":{"$type":"number","$value":2},"c":{"$type":"number","$value":3}}';
  const draft = base.replace('"$value":1', '"$value":10').replace('"$value":2', '"$value":20');
  const repository = base.replace('"$value":1', '"$value":11').replace('"$value":3', '"$value":30');
  const [conflict] = conflicts(base, draft, repository);
  assert(conflict); assert.deepEqual(conflict.parts, ['a', '$value']);
  for (const [keep, value] of [['draft', 10], ['repository', 11], ['custom', 12]] as const) {
    const result = mergeRepositorySources(file(base), file(draft), file(repository), [{ id: conflict.id, keep, ...(keep === 'custom' ? { value } : {}) }]);
    const workspace = openWorkspace('Merged', result);
    assert.equal(workspace.graph.resolved.get('a'), value); assert.equal(workspace.graph.resolved.get('b'), 20); assert.equal(workspace.graph.resolved.get('c'), 30);
  }
});

await test('a resolution is bound to all three reviewed values and ignores only object key ordering', () => {
  const base = '{"a":{"$type":"dimension","$value":{"value":8,"unit":"px"}}}';
  const draft = base.replace('"value":8', '"value":12'); const remote = base.replace('"value":8', '"value":10');
  const first = conflicts(base, draft, remote)[0]; assert(first);
  const newer = remote.replace('"value":10', '"value":11');
  assert.throws(() => mergeRepositorySources(file(base), file(draft), file(newer), [{ id: first.id, keep: 'draft' }]), error => {
    assert(error instanceof RepositoryReviewChanged); assert.equal(error.conflicts.length, 1);
    assert.notEqual(error.conflicts[0]?.id, first.id); assert.equal(repositoryChoiceKey(error.conflicts[0]?.id ?? ''), repositoryChoiceKey(first.id)); return true;
  });
  const reordered = remote.replace('{"value":10,"unit":"px"}', '{"unit":"px","value":10}');
  assert.equal(conflicts(base, draft, reordered)[0]?.id, first.id);
  assert.equal(mergeRepositorySources(file(base), file(draft), file(reordered), [{ id: first.id, keep: 'draft' }])[0]?.text, draft);
});

await test('composite token values are atomic and cannot silently combine unrelated numeric edits', () => {
  const base = '{"a":{"$type":"dimension","$value":{"value":123,"unit":"px"}}}';
  const [conflict] = conflicts(base, base.replace('123', '124'), base.replace('123', '223'));
  assert(conflict); assert.deepEqual(conflict.parts, ['a', '$value']);
  assert.deepEqual(conflict.before, { value: 123, unit: 'px' });
});

await test('token deletion versus edit and file deletion versus edit require explicit choices', () => {
  const base = '{"a":{"$type":"number","$value":1},"b":{"$type":"number","$value":2}}';
  const deleted = '{"b":{"$type":"number","$value":2}}';
  const repository = base.replace('"$value":1', '"$value":3');
  const [conflict] = conflicts(base, deleted, repository);
  assert(conflict); assert.deepEqual(conflict.parts, ['a']);
  const result = mergeRepositorySources(file(base), file(deleted), file(repository), [{ id: conflict.id, keep: 'draft' }]);
  assert(!openWorkspace('Merged', result).graph.tokens.has('a'));
  assert.throws(() => mergeRepositorySources(file(base), [], file(repository)), RepositoryConflicts);
  let id = '';
  try { mergeRepositorySources(file(base), [], file(repository)); } catch (error) { assert(error instanceof RepositoryConflicts); id = error.conflicts[0]?.id ?? ''; }
  assert.deepEqual(mergeRepositorySources(file(base), [], file(repository), [{ id, keep: 'draft' }]), []);
});

await test('unproven formatting or malformed concurrent edits remain explicit whole-file conflicts', () => {
  const base = '{"a":{"$type":"number","$value":1}}';
  const draft = '\n' + base.replace(':1', ':2');
  const repository = base.replace(':1', ':3') + '\n';
  assert.equal(conflicts(base, draft, repository)[0]?.kind, 'file');
  assert.equal(conflicts(base, '{broken', repository)[0]?.kind, 'file');
  assert.equal(mergeRepositorySources(file(base), file('\n' + base), file(base.replace(':1', ':3')))[0]?.text, '\n' + base.replace(':1', ':3'));
});

await test('merge choices reject duplicates and conflicts that no longer exist', () => {
  const base = '{"a":{"$type":"number","$value":1}}';
  const draft = base.replace(':1', ':2'); const repository = base.replace(':1', ':3');
  const [conflict] = conflicts(base, draft, repository); assert(conflict);
  assert.throws(() => mergeRepositorySources(file(base), file(draft), file(repository), [{ id: conflict.id, keep: 'draft' }, { id: conflict.id, keep: 'draft' }]), /only once/u);
  assert.throws(() => mergeRepositorySources(file(base), file(draft), file(base), [{ id: conflict.id, keep: 'draft' }]), /conflict values changed/u);
});

await test('repository reconciliation validates the combined reference graph before applying it', () => {
  const base = '{"a":{"$type":"number","$value":1},"b":{"$type":"number","$value":2}}';
  const draft = openWorkspace('Draft', file(base.replace('"$value":1', '"$value":"{b}"'))); draft.baseline = file(base);
  const repository = openWorkspace('Repository', file(base.replace('"$value":2', '"$value":"{a}"')));
  assert.throws(() => reviewAgainstLatest(draft, repository), /Circular|circular|cycle/u);
  assert.equal(draft.graph.resolved.get('a'), 2); assert.equal(repository.graph.resolved.get('b'), 1);
});

await test('type and inheritance changes are reviewed with the affected definition instead of splitting its semantics', () => {
  const base = '{"group":{"$type":"number","a":{"$value":1},"b":{"$value":2}}}';
  const draft = base.replace('"$value":1', '"$value":3');
  const repository = base.replace('"number"', '"dimension"').replace('"$value":1', '"$value":{"value":4,"unit":"px"}').replace('"$value":2', '"$value":{"value":8,"unit":"px"}');
  const [conflict] = conflicts(base, draft, repository);
  assert(conflict); assert.deepEqual(conflict.parts, ['group']);
  const result = mergeRepositorySources(file(base), file(draft), file(repository), [{ id: conflict.id, keep: 'draft' }]);
  const merged = openWorkspace('Merged', result); assert.equal(merged.graph.resolved.get('group.a'), 3);
  assert.equal(merged.graph.tokens.get('group.a')?.type, 'number');
  const inherited = '{"group":{"$extends":"{base}","a":{"$value":1}}}';
  assert.deepEqual(conflicts(inherited, inherited.replace(':1', ':3'), inherited.replace('{base}', '{other}'))[0]?.parts, ['group']);
});
