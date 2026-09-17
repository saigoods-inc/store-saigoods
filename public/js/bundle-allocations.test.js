import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateAllocations, restoreAllocations} from './bundle-allocations.js';
const bundles=[{id:'one',kind:'box',units:1},{id:'five',kind:'box',units:5},{id:'carton',kind:'case',units:1}];
const sizes=['M','L'];
test('independent bundles combine into unchanged channel payloads',()=>{
 const counts={one:1,five:1,carton:1};
 const grouping={one:{M:1},five:{M:2,L:3},carton:{L:1}};
 const totals=aggregateAllocations(bundles,counts,grouping,sizes);
 assert.deepEqual(totals,{quantities:{M:0,L:1},boxQuantities:{M:3,L:3}});
 assert.deepEqual(restoreAllocations(bundles,counts,totals,sizes,grouping),{one:{M:1,L:0},five:{M:2,L:3},carton:{M:0,L:1}});
 assert.deepEqual(aggregateAllocations(bundles,{...counts,one:0},grouping,sizes).boxQuantities,{M:2,L:3});
});
test('legacy and stale grouping retain exact cart totals',()=>{
 const counts={one:1,five:1,carton:0};
 const row={quantities:{},boxQuantities:{M:2,L:4}};
 for(const saved of [undefined,{one:{M:1},five:{M:2,L:3}}]) {
  const restored=restoreAllocations(bundles,counts,row,sizes,saved);
  assert.equal(Object.values(restored.one).reduce((a,b)=>a+b),1);
  assert.equal(Object.values(restored.five).reduce((a,b)=>a+b),5);
  assert.deepEqual(aggregateAllocations(bundles,counts,restored,sizes).boxQuantities,row.boxQuantities);
 }
});
test('reduced quantities preserve excess for explicit correction instead of moving it to another bundle',()=>{
 const counts={one:1,five:1,carton:0};
 const grouping={one:{M:2},five:{L:4}};
 assert.deepEqual(aggregateAllocations(bundles,counts,grouping,sizes).boxQuantities,{M:2,L:4});
 // Aggregate totals can match while individual bundles are incomplete/overfull.
 assert.notEqual(Object.values(grouping.one).reduce((a,b)=>a+b),counts.one);
 assert.notEqual(Object.values(grouping.five).reduce((a,b)=>a+b),counts.five*5);
});
