import test from 'node:test';
import assert from 'node:assert/strict';
import {startSheetDrag, updateSheetDrag, shouldDismissSheet} from './sheet-drag.js';
const event = (y, timeStamp, x = 0) => ({pointerId: 1, clientX: x, clientY: y, timeStamp});
function gesture(points) {
  const drag = startSheetDrag(event(0, 0));
  for (const point of points.slice(0, -1)) updateSheetDrag(drag, event(...point));
  return shouldDismissSheet(drag, event(...points.at(-1)));
}
test('short deliberate pull dismisses without dragging the full sheet', () => {
  assert.equal(gesture([[48, 500]]), true);
  assert.equal(gesture([[47, 500]]), false);
});
test('quick downward flick dismisses only after a meaningful movement', () => {
  assert.equal(gesture([[24, 40]]), true);
  assert.equal(gesture([[23, 20]]), false);
  assert.equal(gesture([[5, 1]]), false);
});
test('paused and reversed short drags do not inherit earlier flick velocity', () => {
  assert.equal(gesture([[30, 30], [30, 300]]), false);
  assert.equal(gesture([[40, 40], [25, 80]]), false);
});
test('horizontal and upward gestures do not dismiss', () => {
  assert.equal(gesture([[60, 100, 80]]), false);
  assert.equal(gesture([[-60, 100]]), false);
});
