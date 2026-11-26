import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ObsoleteSync, StaleWorkspace, SyncOrder } from '../figma/sync-order.ts';

await test('connection lifetimes reject delayed reads, writes and controller replies', () => {
  const order = new SyncOrder(); const first = order.begin();
  order.accept(first, { id: 'workspace', version: 3 });
  const second = order.begin();
  assert.throws(() => order.assert(first), ObsoleteSync);
  assert.throws(() => order.accept(second, { id: 'workspace', version: 2 }), StaleWorkspace);
  assert.throws(() => order.accept(second, { id: 'workspace' }), StaleWorkspace);
  order.accept(second, { id: 'workspace', version: 3 });
  order.accept(second, { id: 'workspace', version: 4 });
  order.begin();
  assert.throws(() => order.assert(second), ObsoleteSync);
});
