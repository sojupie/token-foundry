import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCuratedFigmaVariable, variableScopes } from '../integrations/figma/scopes.ts';
import { requireValue } from '../lib/json.ts';
import { openWorkspace, revertFileChange, revertTokenChange, workspaceChanges, workspaceTokenChanges } from '../lib/workspace.ts';

await test('workspaceTokenChanges and selective reverts undo individual tokens or single files cleanly', () => {
  const baseline = [
    {
      path: 'tokens/ref.tokens.json',
      text: '{\n  "space": {\n    "small": { "$type": "dimension", "$value": { "value": 8, "unit": "px" } },\n    "medium": { "$type": "dimension", "$value": { "value": 16, "unit": "px" } }\n  }\n}\n',
    },
    {
      path: 'tokens/sys.tokens.json',
      text: '{\n  "gap": { "$type": "dimension", "$value": "{space.small}" }\n}\n',
    },
  ];
  const edited = [
    {
      path: 'tokens/ref.tokens.json',
      text: '{\n  "space": {\n    "small": { "$type": "dimension", "$value": { "value": 12, "unit": "px" } },\n    "medium": { "$type": "dimension", "$value": { "value": 24, "unit": "px" } },\n    "large": { "$type": "dimension", "$value": { "value": 32, "unit": "px" } }\n  }\n}\n',
    },
    {
      path: 'tokens/sys.tokens.json',
      text: '{\n  "gap": { "$type": "dimension", "$value": "{space.medium}" }\n}\n',
    },
    {
      path: 'tokens/extra.tokens.json',
      text: '{\n  "extra": { "$type": "number", "$value": 4 }\n}\n',
    },
  ];

  const workspace = { ...openWorkspace('Selective revert', edited), baseline };
  const tokenDiffs = workspaceTokenChanges(workspace);
  assert.deepEqual(tokenDiffs.map(item => [item.file, item.path, item.kind]), [
    ['tokens/extra.tokens.json', 'extra', 'added'],
    ['tokens/ref.tokens.json', 'space.large', 'added'],
    ['tokens/ref.tokens.json', 'space.medium', 'modified'],
    ['tokens/ref.tokens.json', 'space.small', 'modified'],
    ['tokens/sys.tokens.json', 'gap', 'modified'],
  ]);

  const afterSingleRevert = revertTokenChange(workspace, 'tokens/ref.tokens.json', 'space.small');
  assert.equal(workspaceTokenChanges(afterSingleRevert).some(item => item.path === 'space.small'), false);
  assert.equal(workspaceTokenChanges(afterSingleRevert).some(item => item.path === 'space.medium'), true);
  assert.equal(workspaceTokenChanges(afterSingleRevert).some(item => item.path === 'space.large'), true);

  const afterAddedTokenRevert = revertTokenChange(afterSingleRevert, 'tokens/ref.tokens.json', 'space.large');
  const afterLastInRefRevert = revertTokenChange(afterAddedTokenRevert, 'tokens/ref.tokens.json', 'space.medium');
  assert.equal(afterLastInRefRevert.files.find(file => file.path === 'tokens/ref.tokens.json')?.text, baseline[0]?.text);
  assert.deepEqual(workspaceChanges(afterLastInRefRevert).map(change => change.path), ['tokens/sys.tokens.json', 'tokens/extra.tokens.json']);

  const afterAddedFileTokenRevert = revertTokenChange(afterLastInRefRevert, 'tokens/extra.tokens.json', 'extra');
  assert.equal(afterAddedFileTokenRevert.files.some(file => file.path === 'tokens/extra.tokens.json'), false);

  const afterFileDiscard = revertFileChange(workspace, 'tokens/ref.tokens.json');
  assert.equal(afterFileDiscard.files.find(file => file.path === 'tokens/ref.tokens.json')?.text, baseline[0]?.text);
  assert.deepEqual(workspaceChanges(afterFileDiscard).map(change => change.path), ['tokens/sys.tokens.json', 'tokens/extra.tokens.json']);

  const afterExtraFileDiscard = revertFileChange(afterFileDiscard, 'tokens/extra.tokens.json');
  assert.deepEqual(workspaceChanges(afterExtraFileDiscard).map(change => change.path), ['tokens/sys.tokens.json']);

  const withoutSys = { ...openWorkspace('Removed file', [requireValue(baseline[0], 'baseline file')]), baseline };
  const restoredRemoved = revertFileChange(withoutSys, 'tokens/sys.tokens.json');
  assert.deepEqual(workspaceChanges(restoredRemoved), []);
});

await test('variableScopes and isCuratedFigmaVariable curate v1 variables and scopes cleanly', () => {
  assert.equal(isCuratedFigmaVariable('sevan.ref.palette.primary40'), false);
  assert.deepEqual(variableScopes({ path: 'sevan.ref.palette.primary40', type: 'COLOR', sourceType: 'color' }), []);
  assert.equal(isCuratedFigmaVariable('sevan.sys.color.primary-fixed'), false);
  assert.equal(isCuratedFigmaVariable('sevan.sys.typescale.body-medium-emphasized.size'), false);
  assert.equal(isCuratedFigmaVariable('sevan.comp.button.xlarge.container.height'), false);
  assert.equal(isCuratedFigmaVariable('sevan.comp.button.filled.toggle.selected.container.color'), false);

  assert.equal(isCuratedFigmaVariable('sevan.sys.color.primary'), true);
  assert.equal(isCuratedFigmaVariable('sevan.sys.shape.corner.medium.topLeft'), true);
  assert.equal(isCuratedFigmaVariable('sevan.comp.rich-tooltip.container.shape.bottomRight'), true);

  assert.deepEqual(variableScopes({ path: 'sevan.comp.rich-tooltip.container.shape.bottomRight', type: 'FLOAT', sourceType: 'dimension' }), ['CORNER_RADIUS']);
  assert.deepEqual(variableScopes({ path: 'sevan.sys.shape.corner.extra-large.bottomRight', type: 'FLOAT', sourceType: 'dimension' }), ['CORNER_RADIUS']);
  assert.deepEqual(variableScopes({ path: 'sevan.comp.checkbox.state-layer.size', type: 'FLOAT', sourceType: 'dimension' }), ['WIDTH_HEIGHT']);
  assert.deepEqual(variableScopes({ path: 'sevan.comp.checkbox.hover.state-layer.opacity', type: 'FLOAT', sourceType: 'number' }), ['OPACITY']);
  assert.deepEqual(variableScopes({ path: 'sevan.comp.checkbox.state-layer.shape.radius-ratio', type: 'FLOAT', sourceType: 'number' }), ['WIDTH_HEIGHT']);
  assert.deepEqual(variableScopes({ path: 'sevan.comp.outlined-card.outline.width', type: 'FLOAT', sourceType: 'dimension' }), ['STROKE_FLOAT', 'WIDTH_HEIGHT']);
  assert.deepEqual(variableScopes({ path: 'sevan.sys.measurement.space200', type: 'FLOAT', sourceType: 'dimension' }), ['GAP', 'WIDTH_HEIGHT']);
});
