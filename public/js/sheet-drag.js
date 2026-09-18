// Shared mobile-sheet gesture policy. Distances are CSS pixels; velocity is px/ms.
export function startSheetDrag(event) {
  return {id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, sideways: 0,
    samples: [{y: event.clientY, time: event.timeStamp}]};
}
export function updateSheetDrag(drag, event) {
  drag.distance = Math.max(0, event.clientY - drag.y);
  drag.sideways = Math.abs(event.clientX - drag.x);
  drag.samples.push({y: event.clientY, time: event.timeStamp});
  // Recent motion only: pausing before release must not count as a flick.
  while (drag.samples.length > 1 && drag.samples[0].time < event.timeStamp - 100) drag.samples.shift();
}
export function shouldDismissSheet(drag, event) {
  updateSheetDrag(drag, event);
  if (drag.distance < 24 || drag.sideways >= drag.distance) return false;
  const first = drag.samples[0];
  const elapsed = event.timeStamp - first.time;
  const velocity = elapsed > 0 ? (event.clientY - first.y) / elapsed : 0;
  return drag.distance >= 48 || velocity >= 0.45;
}
