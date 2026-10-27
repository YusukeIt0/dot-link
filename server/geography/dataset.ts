import { validGeometry } from './geometry.ts';
import type { GeographicDataset } from './types.ts';

export function validatedDataset(raw:unknown):raw is GeographicDataset {
  if(!raw||typeof raw!=='object')return false;
  const d=raw as GeographicDataset;
  if(d.source!=='Overture Maps'||!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(d.release)||d.license_url!=='https://docs.overturemaps.org/attribution/'||typeof d.attribution!=='string'||d.attribution.length>1000||!Array.isArray(d.features)||d.features.length>20_000||!Array.isArray(d.limitations)||d.limitations.length>30||!d.limitations.every(l=>typeof l==='string'&&l.length<500))return false;
  let vertices=0;
  const count=(v:unknown):number=>Array.isArray(v)?typeof v[0]==='number'?1:v.reduce((n,item)=>n+count(item),0):0;
  return d.features.every(f=>{
    if(!f||typeof f!=='object'||typeof f.id!=='string'||f.id.length>120||typeof f.kind!=='string'||f.kind.length>100||!['area','line','landmark'].includes(f.category)||!validGeometry(f.geometry,30_000))return false;
    vertices+=count(f.geometry.coordinates);
    if(vertices>800_000)return false;
    if(f.name!==undefined&&(typeof f.name!=='string'||f.name.length>200))return false;
    if(f.names!==undefined&&(typeof f.names!=='object'||f.names===null||Object.entries(f.names).length>6||!Object.entries(f.names).every(([k,v])=>k.length<30&&typeof v==='string'&&v.length<=200)))return false;
    return true;
  });
}
