import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldDependsOn, referenceConsumers } from '../lib/document.ts';
import { compareContexts, compileResolver, resolveResolver, resolvedSnapshot, winningOrigins } from '../lib/resolver.ts';
import { openWorkspace, reviewAgainstLatest, reviewAffectedResolvers, reviewResolverValue, reviewRepositorySources, reviewSetPath, reviewSource, reviewSourcePath, reviewWorkspace } from '../lib/workspace.ts';
import type { JsonObject } from '../lib/json.ts';
import type { TokenFile } from '../lib/token-types.ts';

function file(path: string, tree: JsonObject): TokenFile {
  return { path, tree };
}

const resolver = file('theme.resolver.json', {
  version: '2025.10',
  sets: { base: { sources: [{ $ref: 'source/base.tokens.json' }] } },
  modifiers: { theme: { default: 'light', contexts: {
    light: [{ light: { $type: 'number', $value: 1 } }],
    dark: [{ $ref: 'source/dark.tokens.json' }],
  } } },
  resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' }],
});
const base = file('source/base.tokens.json', {
  spacing: { $type: 'number', gap: { $value: 4, $description: 'Base gap' } },
  derived: { $type: 'number', $value: '{spacing.gap}' },
  pointer: { $type: 'number', $value: { $ref: '#/spacing/gap/$value' } },
});
const dark = file('source/dark.tokens.json', {
  spacing: { gap: { $value: 12 } }, emphasis: { $type: 'number', $value: 5 },
});
const files = [resolver, base, dark];

await test('resolves aliases after contextual overrides and tracks authored origins', () => {
  const model = compileResolver(resolver, files);
  assert.deepEqual(model.issues, []);
  const primary = resolveResolver(model, {});
  const alternative = resolveResolver(model, { THEME: 'Dark' });
  assert.deepEqual(primary.contexts, new Map([['theme', 'light']]));
  assert.deepEqual(alternative.errors, []);
  assert.equal(alternative.graph.resolved.get('derived'), 12);
  assert.equal(alternative.graph.resolved.get('pointer'), 12);
  assert.deepEqual(winningOrigins(alternative, 'spacing.gap'), [
    { file: 'source/base.tokens.json', parts: ['spacing', 'gap'], set: 'base' },
    { file: 'source/dark.tokens.json', parts: ['spacing', 'gap'], modifier: 'theme', context: 'dark' },
  ]);
  assert.equal(alternative.graph.tokens.get('spacing.gap')?.node.$description, undefined);
  assert.deepEqual(compareContexts(primary, alternative).map(({ path, kind }) => [path, kind]), [
    ['derived', 'Changed'], ['emphasis', 'Added'], ['light', 'Removed'], ['pointer', 'Changed'], ['spacing.gap', 'Changed'],
  ]);
  assert.deepEqual(resolvedSnapshot(alternative)['pointer'], { $type: 'number', $value: 12 });
});

await test('validates set cycles, illegal order references, duplicate entries and context choices', () => {
  const source = file('invalid.resolver.json', {
    version: 'old',
    sets: { first: { sources: [{ $ref: '#/sets/second' }] }, second: { sources: [{ $ref: '#/sets/first' }] } },
    modifiers: { theme: { contexts: { dark: [], light: [] } } },
    resolutionOrder: [{ $ref: '#/sets/first' }, { $ref: '#/sets/first' }, { $ref: '#/resolutionOrder/1' }],
  });
  const model = compileResolver(source, [source]);
  const messages = model.issues.map(issue => issue.message).join('\n');
  assert.match(messages, /Resolver version/u);
  assert.match(messages, /Circular set reference/u);
  assert.match(messages, /Duplicate name/u);
  assert.match(messages, /Cannot reference resolutionOrder/u);
  assert.deepEqual(resolveResolver(model, {}).errors, ['Select a context for theme.']);
  assert.deepEqual(resolveResolver(model, { theme: true }).errors, ['Choose a valid context for theme.']);
});

await test('preserves shallow structural ref overrides and their inline author locations', () => {
  const source = file('overlay.resolver.json', {
    version: '2025.10',
    resolutionOrder: [{
      name: 'Inline', type: 'set', sources: [
        { $ref: 'source/base.tokens.json', spacing: { $type: 'number', gap: { $value: 23 } } },
      ],
    }],
  });
  const result = resolveResolver(compileResolver(source, [source, base]), {});
  assert.equal(result.graph.resolved.get('derived'), 23);
  assert.deepEqual(winningOrigins(result, 'spacing.gap').at(-1), {
    file: source.path, parts: ['resolutionOrder', '0', 'sources', '0', 'spacing', 'gap'], set: 'Inline',
  });
});

await test('reviews an inline context override without changing shared source bytes', () => {
  const workspace = openWorkspace('Theme', files.map(source => ({ path: source.path, text: JSON.stringify(source.tree, null, 2) })));
  assert.equal(workspace.graph.documentDiagnostics.length, 0);
  const draft = reviewResolverValue(workspace, resolver.path, ['modifiers', 'theme', 'contexts', 'dark', '1'], {
    spacing: { gap: { $type: 'number', $value: 20 } },
  }, true);
  const review = reviewAffectedResolvers(workspace, draft, { file: resolver.path, contexts: [
    { label: 'Dark', inputs: { theme: 'dark' } }, { label: 'Light', inputs: { theme: 'light' } },
  ] });
  assert.deepEqual(review.contextImpact?.map(context => [context.label, context.changes.map(change => change.path)]), [
    ['Dark', ['derived', 'pointer', 'spacing.gap']], ['Light', []],
  ]);
  assert.equal(review.next.files[1]?.text, workspace.files[1]?.text);
  assert.equal(review.next.files[2]?.text, workspace.files[2]?.text);
});

await test('keeps token names, empty groups, and inherited group members in a snapshot', () => {
  const manifest = file('snapshot.resolver.json', {
    version: '2025.10',
    resolutionOrder: [{ name: 'Base', type: 'set', sources: [{ $ref: 'base.tokens.json' }, {
      sources: { $type: 'number', $value: 4 },
      contexts: { $type: 'number', $value: 5 },
      derived: { x: { $value: 3 } },
    }] }],
  });
  const definitions = file('base.tokens.json', {
    base: { $type: 'number', $description: 'Palette', $extensions: { 'org.example': { flag: true } }, x: { $value: 1 }, y: { $value: 2 } },
    derived: { $ref: '#/base' },
    empty: { $description: 'No tokens yet' },
  });
  const model = compileResolver(manifest, [manifest, definitions]);
  assert.deepEqual(model.issues, []);
  const result = resolveResolver(model, {});
  assert.equal(result.graph.resolved.get('derived.x'), 3);
  assert.equal(result.graph.resolved.get('derived.y'), 2);
  assert.equal(result.graph.resolved.get('sources'), 4);
  assert.equal(result.graph.resolved.get('contexts'), 5);
  const snapshot = resolvedSnapshot(result);
  assert.deepEqual(snapshot['empty'], { $description: 'No tokens yet' });
  assert.deepEqual(snapshot['base'], {
    $type: 'number', $description: 'Palette', $extensions: { 'org.example': { flag: true } },
    x: { $type: 'number', $value: 1 }, y: { $type: 'number', $value: 2 },
  });
});

await test('previews a shared edit in an unselected third context', () => {
  const theme = file('theme.resolver.json', {
    ...resolver.tree,
    modifiers: { theme: { default: 'light', contexts: { light: [], dark: [], dim: [] } } },
  });
  const workspace = openWorkspace('Theme', [theme, base].map(source => ({ path: source.path, text: JSON.stringify(source.tree) })));
  const draft = reviewResolverValue(workspace, base.path, ['spacing', 'gap', '$value'], 9);
  const review = reviewAffectedResolvers(workspace, draft, { file: theme.path, contexts: [
    { label: 'Active', inputs: { theme: 'light' } }, { label: 'Comparison', inputs: { theme: 'dark' } },
  ] });
  assert.deepEqual(review.contextImpact?.map(context => [context.label, context.changes.length]), [
    ['Active', 3], ['Comparison', 3], ['theme / dim', 3],
  ]);
});

await test('renames a set by updating the exact key and every pointer to it', () => {
  const manifest = file('theme.resolver.json', {
    version: '2025.10',
    sets: { 'main/source': { sources: [{ gap: { $type: 'number', $value: 4 } }] } },
    resolutionOrder: [{ $ref: '#/sets/main~1source' }],
    $extensions: { 'org.example': { $ref: '#/sets/main~1source' } },
  });
  const linked = file('other.resolver.json', {
    version: '2025.10',
    resolutionOrder: [{ name: 'Linked', type: 'set', sources: [{ $ref: 'theme.resolver.json#/sets/main~1source' }] }],
  });
  const workspace = openWorkspace('Theme', [manifest, linked].map(source => ({ path: source.path, text: JSON.stringify(source.tree, null, '\t') })));
  const review = reviewSetPath(workspace, manifest.path, 'main/source', 'base~next');
  assert.deepEqual(review.validationErrors, undefined);
  assert.equal(review.structure?.referencesUpdated, 2);
  assert.match(review.next.files[0]?.text ?? '', /"\$ref": "#\/sets\/base~0next"/u);
  assert.match(review.next.files[0]?.text ?? '', /"\$ref": "#\/sets\/main~1source"/u);
  assert.match(review.next.files[1]?.text ?? '', /theme\.resolver\.json#\/sets\/base~0next/u);
  assert.ok(reviewSetPath(workspace, manifest.path, 'main/source').validationErrors?.some(error => error.includes('target is missing')));
});

await test('moves a Resolver manifest with relative sources and keeps its resolved context', () => {
  const workspace = openWorkspace('Theme', files.map(source => ({ path: source.path, text: JSON.stringify(source.tree) })));
  const output = reviewSourcePath(workspace, resolver.path, 'manifest/theme.resolver.json');
  assert.deepEqual(output.validationErrors ?? [], []);
  assert.equal(output.structure?.referencesUpdated, 2);
  assert.match(output.next.files[0]?.text ?? '', /\.\.\/source\/base\.tokens\.json/u);
  const moved = output.next.files[0];
  assert.ok(moved);
  const resolution = resolveResolver(compileResolver(moved, output.next.files), { theme: 'dark' });
  assert.equal(resolution.graph.resolved.get('pointer'), 12);
  assert.ok(reviewSourcePath(workspace, dark.path).validationErrors?.some(error => error.includes('target is missing')));
});

await test('moves a named set while rebasing its sources and every consuming manifest', () => {
  const manifest = file('live/app.resolver.json', {
    version: '2025.10',
    sets: {
      brand: { sources: [{ $ref: '../base.tokens.json' }, { $ref: '#/sets/shared' }, {
        literal: { $type: 'number', $value: 100 },
      }], $extensions: { 'org.example': { pointer: '#/sets/shared', extra: true } } },
      shared: { sources: [{ overlay: { $type: 'number', $value: 7 } }] },
    },
    resolutionOrder: [{ $ref: '#/sets/brand' }],
  });
  const destination = file('archive/sets/central.resolver.json', { version: '2025.10', resolutionOrder: [] });
  const consumer = file('extra.resolver.json', { version: '2025.10', resolutionOrder: [{ $ref: 'live/app.resolver.json#/sets/brand' }] });
  const source = file('base.tokens.json', { gap: { $type: 'number', $value: 8 } });
  const workspace = openWorkspace('Sets', [manifest, destination, consumer, source].map(document => ({
    path: document.path, text: JSON.stringify(document.tree, null, 2).replace('"$value": 100', '"$value": 1e2'),
  })));
  const draft = reviewSetPath(workspace, manifest.path, 'brand', 'design', destination.path);
  const comparison = reviewAffectedResolvers(workspace, draft, { file: manifest.path, contexts: [{ label: 'Active context', inputs: {} }] });
  assert.deepEqual(comparison.validationErrors ?? [], []);
  assert.equal(comparison.structure?.referencesUpdated, 4);
  assert.equal(comparison.structure?.files, 3);
  assert.ok(comparison.contextImpact?.every(context => !context.changes.length));
  const all = comparison.next.files;
  const from = all.find(document => document.path === manifest.path);
  const to = all.find(document => document.path === destination.path);
  const indirect = all.find(document => document.path === consumer.path);
  assert.ok(from && to && indirect);
  assert.deepEqual(from.tree['sets'], { shared: { sources: [{ overlay: { $type: 'number', $value: 7 } }] } });
  assert.deepEqual(from.tree['resolutionOrder'], [{ $ref: '../archive/sets/central.resolver.json#/sets/design' }]);
  assert.deepEqual(to.tree['resolutionOrder'], []);
  assert.match(to.text, /"\$ref": "\.\.\/\.\.\/base\.tokens\.json"/u);
  assert.match(to.text, /"\$ref": "\.\.\/\.\.\/live\/app\.resolver\.json#\/sets\/shared"/u);
  assert.match(to.text, /"pointer": "#\/sets\/shared"/u);
  assert.match(to.text, /"\$value": 1e2/u);
  assert.deepEqual(indirect.tree['resolutionOrder'], [{ $ref: 'archive/sets/central.resolver.json#/sets/design' }]);
  for (const document of [from, indirect]) {
    const resolution = resolveResolver(compileResolver(document, all), {});
    assert.equal(resolution.graph.resolved.get('gap'), 8);
    assert.equal(resolution.graph.resolved.get('overlay'), 7);
  }
  assert.equal(all.find(document => document.path === source.path)?.text, workspace.files[3]?.text);
  assert.throws(() => reviewSetPath(comparison.next, destination.path, 'design', 'shared', manifest.path), /unique set name/u);
});

await test('raw Resolver source review checks every affected manifest and newly authored contexts', () => {
  const second = file('other.resolver.json', {
    version: '2025.10',
    resolutionOrder: [{ name: 'Only', type: 'set', sources: [{ $ref: 'source/base.tokens.json' }] }],
  });
  const workspace = openWorkspace('Theme', [...files, second].map(source => ({ path: source.path, text: JSON.stringify(source.tree) })));
  const bad = JSON.stringify({ ...base.tree, derived: { $type: 'number', $value: '{unavailable}' } });
  const invalid = reviewSource(workspace, base.path, bad, true);
  assert.ok(invalid.validationErrors?.some(message => message.includes(resolver.path) && message.includes('unavailable')));
  assert.ok(invalid.validationErrors?.some(message => message.includes(second.path) && message.includes('unavailable')));
  assert.ok(reviewWorkspace(invalid.next).validationErrors?.some(message => message.includes('unavailable')));
  const expanded = { ...resolver.tree, modifiers: { theme: { default: 'light', contexts: {
    light: [], dark: [], contrast: [{ gap: { $type: 'number', $value: '{does-not-exist}' } }],
  } } } };
  const next = reviewSource(workspace, resolver.path, JSON.stringify(expanded), true);
  assert.ok(next.validationErrors?.some(message => message.includes('contrast') && message.includes('does-not-exist')));
});

await test('raw source review permits repairing one of several existing invalid fields', () => {
  const source = file('composite.tokens.json', {
    timing: { $type: 'transition', $value: {
      duration: { value: 4, unit: 'minute' }, delay: { value: 1, unit: 'minute' }, timingFunction: [0, 0, 1, 1],
    } },
  });
  const manifest = file('example.resolver.json', {
    version: '2025.10', resolutionOrder: [{ name: 'Base', type: 'set', sources: [{ $ref: source.path }] }],
  });
  const workspace = openWorkspace('Theme', [manifest, source].map(document => ({ path: document.path, text: JSON.stringify(document.tree) })));
  const beforeText = workspace.files[1]?.text;
  assert.ok(beforeText);
  const repair = reviewSource(workspace, source.path, beforeText.replace('minute', 'ms'), true);
  assert.deepEqual(repair.validationErrors ?? [], []);
  assert.ok(repair.contextImpact?.some(context => context.changes.some(change =>
    change.path === 'timing' && change.afterProblem?.includes('/delay/unit') && !change.afterProblem.includes('/duration/unit'))));
});

await test('refreshing against a changed Resolver checks new consumers before submitting', () => {
  const raw = files.map(source => ({ path: source.path, text: JSON.stringify(source.tree) }));
  const original = openWorkspace('Theme', raw);
  const staged = reviewSource(original, base.path, JSON.stringify({
    ...base.tree,
    derived: { $type: 'number', $value: '{spacing.gap}' },
    number: { $type: 'number', $value: 9 },
  }), true).next;
  const next = openWorkspace('Theme', raw.map(source => source.path === resolver.path ? {
    path: source.path,
    text: JSON.stringify({ ...resolver.tree, resolutionOrder: [
      { $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' },
      { name: 'Consumer', type: 'set', sources: [{ dependent: { $type: 'fontWeight', $value: '{number}' } }] },
    ] }),
  } : source));
  assert.throws(() => reviewAgainstLatest(staged, next), /Expected a fontWeight reference, found number/u);
});

await test('loads a token group named modifiers from a Format source', () => {
  const source = file('named.tokens.json', { modifiers: { gap: { $type: 'number', $value: 6 } } });
  const manifest = file('theme.resolver.json', {
    version: '2025.10', resolutionOrder: [{ name: 'Tokens', type: 'set', sources: [{ $ref: 'named.tokens.json#/modifiers' }] }],
  });
  const model = compileResolver(manifest, [manifest, source]);
  assert.deepEqual(model.issues, []);
  assert.equal(resolveResolver(model, {}).graph.resolved.get('gap'), 6);
});

await test('checks interacting modifiers when neither individual change breaks the default view', () => {
  const manifest = file('theme.resolver.json', {
    version: '2025.10',
    sets: { base: { sources: [{ g: { $type: 'number', x: { $type: 'number', $value: 1 } } }] } },
    modifiers: {
      a: { default: 'off', contexts: { off: [], on: [{ g: { x: { $type: 'number', $value: 1 } } }] } },
      b: { default: 'off', contexts: { off: [], on: [{ g: { $type: 'dimension' } }] } },
    },
    resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/a' }, { $ref: '#/modifiers/b' }],
  });
  const text = JSON.stringify(manifest.tree);
  const workspace = openWorkspace('Theme', [{ path: manifest.path, text }]);
  const applied = text.replace('"on":[{"g":{"x":{"$type":"number","$value":1}}}]', '"on":[{"g":{"x":{"$value":1}}}]');
  const review = reviewSource(workspace, manifest.path, applied, true);
  assert.equal(review.validationErrors?.length, 1);
  assert.match(review.validationErrors?.[0] ?? '', /a \/ on · b \/ on · g\.x · \$value · Expected an object with value and unit/u);
  assert.deepEqual(reviewWorkspace(review.next).validationErrors, review.validationErrors);
  assert.ok(review.contextImpact?.some(context => context.label.includes('a / on · b / on')));
});

await test('validates standalone sources even when a Resolver is open', () => {
  const manifest = file('theme.resolver.json', { version: '2025.10', resolutionOrder: [] });
  const plain = file('unused.tokens.json', { x: { $type: 'number', $value: 8 } });
  const original = [manifest, plain].map(document => ({ path: document.path, text: JSON.stringify(document.tree) }));
  const workspace = openWorkspace('Theme', original);
  const changed = '{"x":{"$type":"number","$value":"invalid"}}';
  const draft = reviewSource(workspace, plain.path, changed, true);
  assert.match(draft.validationErrors?.join('\n') ?? '', /x · \$value · Expected a finite number/u);
  assert.deepEqual(reviewWorkspace(draft.next).validationErrors, draft.validationErrors);
  assert.deepEqual(reviewRepositorySources('Theme', original, draft.next.files).validationErrors, draft.validationErrors);
});

await test('standalone aliases can reach the same open sources used by a Resolver', () => {
  const original = openWorkspace('Theme', [
    { path: 'theme.resolver.json', text: '{"version":"2025.10","resolutionOrder":[{"name":"Base","type":"set","sources":[{"$ref":"base.tokens.json"}]}]}' },
    { path: 'base.tokens.json', text: '{"base":{"$type":"number","$value":4}}' },
    { path: 'extra.tokens.json', text: '{"extra":{"$type":"number","$value":"{base}"},"pointed":{"$ref":"base.tokens.json#/base/$value"}}' },
  ]);
  assert.equal(original.graph.resolved.get('extra'), 4);
  assert.equal(original.graph.resolved.get('pointed'), 4);
  assert.equal(original.graph.issues.size, 0);
  const edited = reviewSource(original, 'base.tokens.json', '{"base":{"$type":"number","$value":9}}', true);
  assert.deepEqual(edited.validationErrors ?? [], []);
  assert.deepEqual(edited.impact, [{ path: 'extra', before: 4, after: 9 }, { path: 'pointed', before: 4, after: 9 }]);
});

await test('resolves standalone file-qualified pointers when Resolver sources override the same path', () => {
  const original = openWorkspace('Theme', [
    { path: 'theme.resolver.json', text: '{"version":"2025.10","resolutionOrder":[{"name":"Base","type":"set","sources":[{"$ref":"base.tokens.json"},{"$ref":"override.tokens.json"}]}]}' },
    { path: 'base.tokens.json', text: '{"base":{"$type":"number","$value":4}}' },
    { path: 'override.tokens.json', text: '{"base":{"$ref":"#/other/$value"},"other":{"$type":"dimension","$value":{"value":8,"unit":"px"}}}' },
    { path: 'extra.tokens.json', text: '{"ambiguous":{"$value":"{base}"},"first":{"$ref":"base.tokens.json#/base/$value"},"second":{"$ref":"override.tokens.json#/base/$value"},"field":{"$type":"number","$ref":"override.tokens.json#/base/$value/value"},"wrong":{"$type":"number","$ref":"override.tokens.json#/base/$value"}}' },
  ]);
  assert.equal(original.graph.resolved.get('first'), 4);
  assert.deepEqual(original.graph.resolved.get('second'), { value: 8, unit: 'px' });
  assert.equal(original.graph.resolved.get('field'), 8);
  assert.match(original.graph.issues.get('ambiguous') ?? '', /Conflicting source definitions/u);
  assert.match(original.graph.issues.get('wrong') ?? '', /Expected a number reference, found dimension/u);
  assert.deepEqual(referenceConsumers(original.graph, 'other').downstream, new Set(['second', 'field', 'wrong']));
  assert.deepEqual(referenceConsumers(original.graph, 'base').direct, new Set(['first', 'ambiguous']));
  assert.equal(fieldDependsOn(original.graph, 'second', [], 'other'), true);
  assert.equal(fieldDependsOn(original.graph, 'second', [], 'base'), false);
  const edited = reviewSource(original, 'override.tokens.json', '{"base":{"$ref":"#/other/$value"},"other":{"$type":"dimension","$value":{"value":9,"unit":"px"}}}', true);
  assert.deepEqual(edited.validationErrors ?? [], []);
  assert.deepEqual(edited.impact?.find(change => change.path === 'second')?.after, { value: 9, unit: 'px' });
});

await test('groups equivalent Resolver choices without overlooking interactions with a distinct choice', () => {
  const contexts = { first: [], second: [], third: [], separate: [{ $ref: 'override.tokens.json' }] };
  const modifiers = Object.fromEntries(['a', 'b', 'c'].map(name => [name, { contexts, default: 'first' }]));
  const manifest = {
    version: '2025.10', modifiers,
    resolutionOrder: [{ name: 'Base', type: 'set', sources: [{ $ref: 'base.tokens.json' }] },
      ...Object.keys(modifiers).map(name => ({ $ref: '#/modifiers/' + name }))],
  };
  const workspace = openWorkspace('Theme', [
    { path: 'theme.resolver.json', text: JSON.stringify(manifest) },
    { path: 'base.tokens.json', text: '{"base":{"$type":"number","$value":4}}' },
    { path: 'override.tokens.json', text: '{"extra":{"$type":"number","$value":"{base}"}}' },
  ]);
  const review = reviewSource(workspace, 'base.tokens.json', '{"base":{"$type":"number","$value":5}}', true);
  assert.deepEqual(review.validationErrors ?? [], []);
  // Keep each single choice in the review and inspect one representative per
  // remaining combination of distinct source selections.
  assert.equal(review.contextImpact?.length, 11);
  assert.ok(review.contextImpact?.find(context => context.matching?.some(label => label.endsWith('a / separate · b / separate · c / separate')))
    ?.changes.some(change => change.path === 'extra' && change.after === 5));
});
