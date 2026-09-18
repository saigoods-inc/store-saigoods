// UI-only grouping. API quantities remain aggregated by size and channel.
export function aggregateAllocations(bundles, counts, allocations, sizes) {
  const quantities = Object.fromEntries(sizes.map(s => [s, 0]));
  const boxQuantities = { ...quantities };
  for (const b of bundles) {
    if (!(counts[b.id] > 0)) continue;
    const target = b.kind === 'box' ? boxQuantities : quantities;
    for (const s of sizes) target[s] += Math.max(0, Math.floor(Number(allocations[b.id]?.[s]) || 0));
  }
  return { quantities, boxQuantities };
}

export function restoreAllocations(bundles, counts, row, sizes, saved) {
  const clean = Object.fromEntries(bundles.map(b => [b.id, Object.fromEntries(sizes.map(s => [s, Math.max(0, Math.floor(Number(saved?.[b.id]?.[s]) || 0))]))]));
  const aggregate = aggregateAllocations(bundles, counts, clean, sizes);
  const same = ['quantities', 'boxQuantities'].every(key => sizes.every(s => aggregate[key][s] === (Number(row[key]?.[s]) || 0)));
  const fits = bundles.every(b => Object.values(clean[b.id]).reduce((a,n)=>a+n,0) === (counts[b.id] || 0) * b.units);
  if (saved && same && fits) return clean;
  // Older carts retain their exact size totals; only their visual grouping is reconstructed.
  const remaining = { box: { ...row.boxQuantities }, case: { ...row.quantities } };
  const result = {};
  for (const b of bundles) {
    let capacity = (counts[b.id] || 0) * b.units;
    result[b.id] = {};
    for (const s of sizes) {
      const take = Math.min(capacity, Math.max(0, Number(remaining[b.kind]?.[s]) || 0));
      result[b.id][s] = take;
      remaining[b.kind][s] = (Number(remaining[b.kind][s]) || 0) - take;
      capacity -= take;
    }
  }
  // Preserve excess allocations for explicit correction, never silently discard cart quantities.
  for (const kind of ['box', 'case']) {
    const b = bundles.find(b => b.kind === kind && counts[b.id] > 0);
    if (b) for (const s of sizes) result[b.id][s] += Math.max(0, Number(remaining[kind][s]) || 0);
  }
  return result;
}
