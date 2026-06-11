// public/order.js  (ESM — used by the browser AND by the Node tests)
const CYCLE = ['chrono', 'inverse', 'random'];

export function nextMode(mode) {
  const i = CYCLE.indexOf(mode);
  return i === -1 ? 'chrono' : CYCLE[(i + 1) % CYCLE.length];
}

export function orderItems(items, mode, rng = Math.random) {
  const arr = items.slice();
  if (mode === 'inverse') return arr.reverse();
  if (mode === 'random') {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  return arr; // chronological
}
