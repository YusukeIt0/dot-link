import test from 'node:test';
import assert from 'node:assert/strict';
import { geographicRegion, overtureFeature } from '../server/geography/overture.ts';

test('fixed regions are stable within a cell, cover cell seams, and split at the dateline',()=>{
 const a=geographicRegion({longitude:100.501,latitude:13.701,accuracy:5})!;
 const b=geographicRegion({longitude:100.519,latitude:13.719,accuracy:5})!;
 assert.deepEqual(a,b);
 assert.ok(a.boxes[0].xmin<a.core.xmin&&a.boxes[0].xmax>a.core.xmax);
 const date=geographicRegion({longitude:179.999,latitude:10,accuracy:5})!;
 assert.equal(date.boxes.length,2);assert.equal(date.boxes[0].xmin,-180);assert.equal(date.boxes[1].xmax,180);
 assert.equal(geographicRegion({longitude:0,latitude:89,accuracy:5}),undefined);
});

test('Overture adapter preserves geographic names without guessing label joins or translating',()=>{
 const park=overtureFeature('land_use',{id:'a',class:'park',subtype:'recreation',names:{primary:'สวนลุมพินี',common:{en:'Lumphini Park',ja:'ルンピニー公園',ko:'룸피니 공원'}},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}})!;
 assert.equal(park.name,'สวนลุมพินี');assert.equal(park.category,'area');assert.equal(park.names?.ja,'ルンピニー公園');
 const rail=overtureFeature('segment',{id:'b',class:'subway',subtype:'rail',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]}})!;
 assert.equal(rail.kind,'rail/subway');assert.equal(rail.name,undefined);
 const peak=overtureFeature('land',{id:'c',class:'peak',geometry:{type:'Point',coordinates:[138.7,35.3]},names:{primary:'富士山'}})!;
 assert.equal(peak.category,'landmark');assert.equal(peak.name,'富士山');
 assert.equal(overtureFeature('land',{id:'d',class:'tree',geometry:{type:'Point',coordinates:[0,0]}}),undefined);
 assert.equal(overtureFeature('land',{id:'../unsafe',class:'peak',geometry:{type:'Point',coordinates:[0,0]}}),undefined);
 assert.equal(overtureFeature('land',{id:'d',class:'peak',geometry:{type:'Point',coordinates:[200,0]}}),undefined);
});
