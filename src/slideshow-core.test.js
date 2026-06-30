import test from 'node:test';
import assert from 'node:assert/strict';
import { nextUnseenIndex } from './slideshow-core.js';

// "Unseen" must never loop back onto already-seen posts. nextUnseenIndex finds the next
// NOT-yet-seen item going forward (no wrap); -1 means "nothing unseen ahead" (caller -> caught up / wait).
test('nextUnseenIndex: returns the next not-seen item going forward', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const seen = new Set(['a', 'b']);
  const isSeen = (id) => seen.has(id);
  assert.equal(nextUnseenIndex(list, 0, isSeen), 2); // a seen -> next unseen is c
  assert.equal(nextUnseenIndex(list, 1, isSeen), 2);
  assert.equal(nextUnseenIndex(list, 2, isSeen), 3); // c -> d
});

test('nextUnseenIndex: -1 when everything ahead is already seen (all caught up)', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextUnseenIndex(list, 0, () => true), -1);
  assert.equal(nextUnseenIndex(list, 2, () => true), -1);
});

test('nextUnseenIndex: skips already-seen items in the middle (no re-show)', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const seen = new Set(['b', 'c']);
  const isSeen = (id) => seen.has(id);
  assert.equal(nextUnseenIndex(list, 0, isSeen), 3); // from a -> skip seen b,c -> d
});

test('nextUnseenIndex: never wraps; nothing AFTER the last index', () => {
  assert.equal(nextUnseenIndex([], 0, () => false), -1);
  assert.equal(nextUnseenIndex([{ id: 'a' }], 0, () => false), -1); // only item, nothing ahead
  assert.equal(nextUnseenIndex([{ id: 'a' }, { id: 'b' }], 1, () => false), -1);
});

test('nextUnseenIndex: tolerates null entries in the list', () => {
  const list = [{ id: 'a' }, null, { id: 'c' }];
  assert.equal(nextUnseenIndex(list, 0, () => false), 2);
});
