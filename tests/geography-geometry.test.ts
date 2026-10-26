import test from 'node:test';
import assert from 'node:assert/strict';
import { geographicEvidence, spatialRelation, validGeometry } from '../server/geography/geometry.ts';
import type { GeographicDataset, GeographicFeature, Geometry } from '../server/geography/types.ts';

const fix = {latitude: 0, longitude: 0, accuracy: 10};
const square: Geometry = {type:'Polygon', coordinates:[[[-.01,-.01],[.01,-.01],[.01,.01],[-.01,.01],[-.01,-.01]]]};
const dataset = (features: GeographicFeature[]): GeographicDataset => ({source:'fixture',release:'test',attribution:'Synthetic geometry',license_url:'https://example.test/license',features,limitations:[]});

test('containing park, nearby unnamed path and named landmark remain separate evidence', () => {
  const result = geographicEvidence(fix,dataset([
    {id:'park',kind:'park',name:'Example Park',category:'area',geometry:square},
    {id:'path',kind:'path',category:'line',geometry:{type:'LineString',coordinates:[[.0003,-.001],[.0003,.001]]}},
    {id:'peak',kind:'peak',name:'Example Peak',category:'landmark',geometry:{type:'Point',coordinates:[.01,0]}},
  ]));
  assert.equal(result.areas[0].relation,'within_mapped_area');
  assert.equal(result.lines[0].name,undefined);
  assert.equal(result.lines[0].relation,'near');
  assert.ok(result.lines[0].distance_m >= 32 && result.lines[0].distance_m <= 34);
  assert.equal(result.lines[0].bearing_degrees,90);
  assert.equal(result.landmarks[0].kind,'peak');
});

test('measurement uncertainty at either side of a polygon boundary prevents definite containment', () => {
  for(const longitude of [.00995,.01005]) {
    const result=geographicEvidence({...fix,longitude},dataset([{id:'p',kind:'park',category:'area',geometry:square}]));
    assert.equal(result.areas[0].relation,'boundary_uncertain');
    assert.equal(result.areas[0].bearing_degrees,undefined);
  }
});

test('polygon holes and disjoint multipolygon parts are not filled', () => {
  assert.equal(square.type,'Polygon');
  if(square.type!=='Polygon')return;
  const hole: Geometry={type:'Polygon',coordinates:[...square.coordinates,[[-.001,-.001],[-.001,.001],[.001,.001],[.001,-.001],[-.001,-.001]]]};
  assert.equal(spatialRelation(fix,hole).inside,false);
  assert.equal(spatialRelation({...fix,longitude:.005},hole).inside,true);
  const multi: Geometry={type:'MultiPolygon',coordinates:[[[[-.02,-.01],[-.01,-.01],[-.01,.01],[-.02,.01],[-.02,-.01]]],[[[.01,-.01],[.02,-.01],[.02,.01],[.01,.01],[.01,-.01]]]]};
  assert.equal(spatialRelation(fix,multi).inside,false);
});

test('an antimeridian polygon contains nearby dateline points but not the opposite hemisphere', () => {
  const shape: Geometry={type:'Polygon',coordinates:[[[179,-1],[-179,-1],[-179,1],[179,1],[179,-1]]]};
  assert.equal(spatialRelation({...fix,longitude:179.9},shape).inside,true);
  assert.equal(spatialRelation({...fix,longitude:-179.9},shape).inside,true);
  assert.equal(spatialRelation(fix,shape).inside,false);
});

test('unnamed forest and empty coverage stay useful without inventing a named place', () => {
  const forest=geographicEvidence(fix,dataset([{id:'forest',kind:'forest',category:'area',geometry:square}]));
  assert.equal(forest.areas[0].name,undefined);assert.equal(forest.areas[0].kind,'forest');
  const empty=geographicEvidence(fix,dataset([]));
  assert.deepEqual(empty.areas,[]);assert.deepEqual(empty.lines,[]);assert.ok(empty.limitations.length);
});

test('parallel and crossing lines are only near references, never road membership or intersections', () => {
  const features: GeographicFeature[]=[-.0002,.0002].map((x,i)=>({id:`r${i}`,kind:'road',name:`Road ${i}`,category:'line',geometry:{type:'LineString',coordinates:[[x,-.001],[x,.001]]}}));
  const result=geographicEvidence(fix,dataset(features));
  assert.equal(result.lines.length,2);assert.ok(result.lines.every(l=>l.relation==='near'));
});

test('malformed, oversized, unclosed or nonfinite external geometry is rejected', () => {
  assert.equal(validGeometry(square),true);
  assert.equal(validGeometry(square,4),false);
  for(const geometry of [null,{type:'Point',coordinates:[NaN,0]},{type:'Point',coordinates:[181,0]},{type:'Point',coordinates:[0,91]},{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]},{type:'GeometryCollection',geometries:[]}])assert.equal(validGeometry(geometry),false);
  assert.throws(()=>geographicEvidence({...fix,latitude:90},dataset([])),/Unsupported/);
});

test('dense unnamed paths and repeated segments do not hide nearby named streets',()=>{
 const paths: GeographicFeature[]=Array.from({length:8},(_,i)=>({id:`p${i}`,kind:'footway',category:'line',geometry:{type:'LineString',coordinates:[[(i+1)*.0001,-.001],[(i+1)*.0001,.001]]}}));
 paths.push(...[0,1].map(i=>({id:`s${i}`,kind:'road',name:'Example Street',category:'line' as const,geometry:{type:'LineString' as const,coordinates:[[.002,-.001],[.002,.001]] as [number,number][]}})));
 const result=geographicEvidence(fix,dataset(paths));
 assert.equal(result.lines.length,6);assert.equal(result.lines.filter(l=>l.name==='Example Street').length,1);
 assert.equal(result.lines[0].name,undefined);
});
