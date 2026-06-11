// test/order.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMode, orderItems } from './order.js';

test('nextMode cycles chrono -> inverse -> random -> chrono', () => {
  assert.equal(nextMode('chrono'), 'inverse');
  assert.equal(nextMode('inverse'), 'random');
  assert.equal(nextMode('random'), 'chrono');
  assert.equal(nextMode('unknown'), 'chrono'); // robust default
});

test('orderItems chrono returns a copy in the same order', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const out = orderItems(items, 'chrono');
  assert.deepEqual(out, items);
  assert.notEqual(out, items); // copy, not the same reference
});

test('orderItems inverse reverses without mutating the input', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(orderItems(items, 'inverse').map(x => x.id), [3, 2, 1]);
  assert.deepEqual(items.map(x => x.id), [1, 2, 3]); // unchanged
});

test('orderItems random is deterministic with an injected rng', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const out = orderItems(items, 'random', () => 0); // rng=0 => deterministic Fisher-Yates
  assert.equal(out.length, 4);
  assert.deepEqual([...out].map(x => x.id).sort(), [1, 2, 3, 4]); // same elements
  assert.deepEqual(items.map(x => x.id), [1, 2, 3, 4]); // input unchanged
});
