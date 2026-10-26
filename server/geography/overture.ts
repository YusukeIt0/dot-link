import { parquetMetadataAsync, parquetReadObjects, parquetScan } from 'hyparquet';
import { mapCompressors as compressors } from './compression.ts';
import { GeographicCache } from './cache.ts';
import { MapDownload } from './download.ts';
import { validGeometry } from './geometry.ts';
import type { GeographicDataset, GeographicFeature, GeographicFix } from './types.ts';

const ROOT = 'https://stac.overturemaps.org';
const DAY = 86_400_000;
const RELEASE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const THEMES = ['segment', 'land_use', 'land', 'water'] as const;
type Theme = typeof THEMES[number];
type Box = {xmin:number; ymin:number; xmax:number; ymax:number};
const record = (v: unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const text = (v: unknown, max = 200): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v) ? v : undefined;
function box(v: unknown): Box | undefined {
  const b = record(v);
  if (['xmin','ymin','xmax','ymax'].some(k => typeof b[k] !== 'number' || !Number.isFinite(b[k]))) return;
  const value = b as Box;
  if (value.xmin < -180 || value.xmax > 180 || value.ymin < -90 || value.ymax > 90 || value.xmin > value.xmax || value.ymin > value.ymax) return;
  return value;
}
const overlaps = (a: Box,b: Box) => a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;
export interface GeographicRegion { key: string; boxes: Box[]; core: Box }
export function geographicRegion(fix: GeographicFix): GeographicRegion | undefined {
  if (!Number.isFinite(fix.latitude) || Math.abs(fix.latitude)>85 || !Number.isFinite(fix.longitude) || Math.abs(fix.longitude)>180) return;
  const x = Math.min(17999,Math.floor((fix.longitude+180)/.02)), y = Math.floor((fix.latitude+90)/.02);
  const core = {xmin:x*.02-180, xmax:(x+1)*.02-180, ymin:y*.02-90,ymax:(y+1)*.02-90};
  const margin = .01 / Math.cos(Math.max(Math.abs(core.ymin), Math.abs(core.ymax))*Math.PI/180);
  const b = {xmin:core.xmin-margin,xmax:core.xmax+margin,ymin:core.ymin-.01,ymax:core.ymax+.01};
  const boxes: Box[] = [];
  if (b.xmin < -180) {boxes.push({...b,xmin:b.xmin+360,xmax:180}); b.xmin=-180;}
  if (b.xmax > 180) {boxes.push({...b,xmin:-180,xmax:b.xmax-360}); b.xmax=180;}
  boxes.push(b);
  return {key:`v1-${x}-${y}`,boxes,core};
}

export function overtureFeature(theme: Theme, raw: unknown): GeographicFeature | undefined {
  const row = record(raw), id = text(row.id,100);
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id) || !validGeometry(row.geometry,30_000)) return;
  const klass = text(row.class,60), subtype = text(row.subtype,60);
  if (!klass || !/^[a-z_]+$/.test(klass) || (subtype && !/^[a-z_]+$/.test(subtype))) return;
  // Individual trees and commercial POIs are not a substitute for area context.
  if (theme === 'land' && ['tree','land'].includes(klass)) return;
  if (theme === 'segment' && subtype !== 'road') return;
  const geometry = row.geometry;
  const category = geometry.type === 'Polygon' || geometry.type === 'MultiPolygon' ? 'area' : geometry.type === 'LineString' || geometry.type === 'MultiLineString' ? 'line' : 'landmark';
  if (theme === 'segment' && category !== 'line') return;
  const sourceNames = record(row.names), name = text(sourceNames.primary);
  const names: Record<string,string> = {};
  const translations=Object.entries(record(sourceNames.common));
  translations.sort(([a],[b])=>Number(['en','ja','ko'].includes(b))-Number(['en','ja','ko'].includes(a))||a.localeCompare(b));
  for (const [language,value] of translations.slice(0,6)) {
    const label = text(value); if (label && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)) names[language]=label;
  }
  return {id:`${theme}:${id}`,kind:theme==='segment'?`${subtype??'transport'}/${klass}`:klass,category,
    ...(name?{name}:{}),...(Object.keys(names).length?{names}:{}),geometry};
}

export async function acquireGeography(options: {
  region: GeographicRegion; cache: GeographicCache; signal: AbortSignal;
  progress?: (dataset: GeographicDataset) => void; request?: typeof fetch; now?: () => number;
}): Promise<{dataset: GeographicDataset; complete: boolean; stats:{downloadedBytes:number;cacheBytes:number}}> {
  const now = options.now ?? Date.now;
  const signal = AbortSignal.any([options.signal,AbortSignal.timeout(360_000)]);
  const download = new MapDownload(options.cache,signal,options.request);
  const cachedRelease = await options.cache.get('overture-catalog-release-v1');
  let release: string | undefined;
  if (cachedRelease && Math.floor(now()/DAY)-cachedRelease.createdDay<1) {
    const candidate=Buffer.from(cachedRelease.bytes).toString('utf8'); if(RELEASE.test(candidate))release=candidate;
  }
  if (!release) {
    const root=record(await download.json(`${ROOT}/catalog.json`));
    if (typeof root.latest !== 'string' || !RELEASE.test(root.latest)) throw new Error('Unsupported map release');
    release=root.latest;
    await options.cache.put('overture-catalog-release-v1',Buffer.from(release),signal);
  }
  const catalogURL=`${ROOT}/${release}/collections.parquet`;
  const cachedCatalog=await options.cache.get(catalogURL);
  const bytes=cachedCatalog?.bytes ?? await download.document(catalogURL);
  signal.throwIfAborted();
  if (!cachedCatalog) await options.cache.put(catalogURL,bytes,signal);
  const catalogFile={byteLength:bytes.byteLength,slice:(s:number,e=bytes.byteLength)=>Uint8Array.from(bytes.subarray(s,e)).buffer};
  const catalogMetadata=await parquetMetadataAsync(catalogFile);
  if(catalogMetadata.row_groups.some(g=>g.columns.some(c=>!['ZSTD','UNCOMPRESSED'].includes(c.meta_data?.codec??''))))throw new Error('Unsupported map compression');
  const catalogDecoded=catalogMetadata.row_groups.reduce((n,g)=>n+g.columns.reduce((sum,c)=>sum+Number(c.meta_data?.total_uncompressed_size??Infinity),0),0);
  if (Number(catalogMetadata.num_rows)>10_000||!Number.isFinite(catalogDecoded)||catalogDecoded>32*1024*1024) throw new Error('Map catalog limit');
  const entries=await parquetReadObjects({file:catalogFile,metadata:catalogMetadata,compressors});
  const features: GeographicFeature[]=[];
  const limitations=new Set<string>(['Reference data is not navigation or access guidance.','Very large features and excessive detail may be omitted by resource limits. Individual trees, generic land extents and rail networks are excluded.']);
  const dataset = (): GeographicDataset => ({source:'Overture Maps',release:release!,
    attribution:'© OpenStreetMap contributors, Overture Maps Foundation. Transportation includes TomTom data. Base includes Daylight, ESA WorldCover / Copernicus Sentinel, ETOPO1 and GLOBathy.',
    license_url:'https://docs.overturemaps.org/attribution/',features:[...features],limitations:[...limitations]});
  let failures=0, successes=0;
  for (const theme of THEMES) {
    let themeVertices=0, themeFeatures=0;
    signal.throwIfAborted();
    const selected=entries.filter(e=>e.type==='Feature'&&e.collection===theme&&box(e.bbox)&&options.region.boxes.some(b=>overlaps(box(e.bbox)!,b)));
    if (selected.length>12) limitations.add(`${theme}: file limit; coverage is partial.`);
    for (const entry of selected.slice(0,12)) {
      try {
        signal.throwIfAborted();
        const asset=record(record(entry.assets).azure), url=text(asset.href,1000);
        const size=Number(asset['file:size']);
        const directory=theme==='segment'?'transportation':'base';
        if (!url || !url.startsWith(`https://overturemapswestus2.blob.core.windows.net/release/${release}/theme=${directory}/type=${theme}/`) || !/\/part-[a-zA-Z0-9-]+\.zstd\.parquet$/.test(url)) throw new Error('Unexpected map asset');
        const file=await download.file(url,size);
        const metadata=await parquetMetadataAsync(file);
        if (metadata.row_groups.length>1024 || metadata.schema.length>1024) throw new Error('Map metadata limit');
        const filter={$or:options.region.boxes.map(b=>({'bbox.xmin':{$lte:b.xmax},'bbox.xmax':{$gte:b.xmin},'bbox.ymin':{$lte:b.ymax},'bbox.ymax':{$gte:b.ymin}}))};
        const scan=await parquetScan({file,metadata,compressors,pruningFilter:filter});
        if(scan.ranges.length>32) throw new Error('Map row group limit');
        for (const range of scan.ranges) {
          signal.throwIfAborted();
          if(range.rowEnd-range.rowStart>50_000) throw new Error('Map row count limit');
          // Guard declared decoded sizes before any decompressor allocates memory.
          let groupStart=0;
          for(const group of metadata.row_groups) {
            const groupEnd=groupStart+Number(group.num_rows);
            if(groupStart<range.rowEnd&&groupEnd>range.rowStart) {
              const selectedColumns=group.columns.filter(c=>['bbox','id','geometry','names','class','subtype'].includes(c.meta_data?.path_in_schema[0]??''));
              if(selectedColumns.some(c=>!['ZSTD','UNCOMPRESSED'].includes(c.meta_data?.codec??'')))throw new Error('Unsupported map compression');
              const decoded=selectedColumns.reduce((sum,c)=>sum+Number(c.meta_data?.total_uncompressed_size??Infinity),0);
              if(!Number.isFinite(decoded)||decoded>64*1024*1024) throw new Error('Map decoded column limit');
            }
            groupStart=groupEnd;
          }
          const boxes=await scan.readColumn({...range,column:'bbox'});
          const indices:number[]=[];
          Array.from(boxes).forEach((raw,i)=>{const b=box(raw);if(b&&b.xmax-b.xmin<20&&b.ymax-b.ymin<20&&options.region.boxes.some(region=>overlaps(b,region)))indices.push(i);});
          if(!indices.length)continue;
          const classes=await scan.readColumn({...range,column:'class'});
          const subtypes=await scan.readColumn({...range,column:'subtype'});
          const relevant=indices.filter(i=>theme==='land'?!['tree','land'].includes(String(classes[i])):theme==='segment'?subtypes[i]==='road':true);
          if(!relevant.length)continue;
          const columns=['id','geometry','names','class','subtype'];
          const values=await Promise.all(columns.map(column=>column==='class'?classes:column==='subtype'?subtypes:scan.readColumn({...range,column})));
          for(const i of relevant) {
            const feature=overtureFeature(theme,Object.fromEntries(columns.map((c,j)=>[c,values[j][i]])));
            if(!feature)continue;
            // Count validated coordinates without allocating a flattened copy.
            const count=(v:unknown):number=>Array.isArray(v)?typeof v[0]==='number'?1:v.reduce((n,item)=>n+count(item),0):0;
            const vertices=count(feature.geometry.coordinates);
            if(themeFeatures >= (theme==='segment'?8000:4000) || themeVertices+vertices>200_000) {limitations.add(`${theme}: detail limit; coverage is partial.`); continue;}
            themeFeatures++; themeVertices+=vertices;
            features.push(feature);
          }
        }
        successes++;
      } catch {
        signal.throwIfAborted();
        failures++;
        limitations.add(`${theme}: some source data could not be loaded; coverage is partial.`);
      }
    }
    const partial=dataset();
    if(theme!==THEMES.at(-1))partial.limitations.push('Additional geographic themes are still loading.');
    options.progress?.(partial);
  }
  if(failures>0&&successes===0)throw new Error('Map data unavailable');
  return {dataset:dataset(),complete:failures===0,stats:download.stats};
}
