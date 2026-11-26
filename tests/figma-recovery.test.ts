import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conflictInputKind, isConflictDraft } from '../integrations/figma/recovery.ts';

await test('conflict input type survives a different resolution choice and leaves old ambiguous text unclassified', () => {
  for (const inputKind of ['value', 'alias'] as const) {
    const draft = { path: 'space', keep: 'source', text: 'exact input ', inputKind };
    assert(isConflictDraft(draft)); assert.equal(conflictInputKind(draft), inputKind);
  }
  assert.equal(conflictInputKind({ path: 'space', keep: 'custom', text: '14' }), 'value');
  assert.equal(conflictInputKind({ path: 'space', keep: 'alias', text: 'other' }), 'alias');
  assert.equal(conflictInputKind({ path: 'space', keep: 'source', text: '14' }), undefined);
  assert.equal(isConflictDraft({ path: 'space', keep: 'source', text: '14', inputKind: 'guess' }), false);
});
