import { parentPort, workerData } from 'node:worker_threads';
import { GeographicCache } from './cache.ts';
import { GeographicResolver } from './resolver.ts';
import type { GeographicFix } from './types.ts';

if(!parentPort)throw new Error('Geography worker needs a parent');
const port=parentPort;
const cache=new GeographicCache(workerData.directory);
const resolver=new GeographicResolver({cache,output:result=>port.postMessage(result)});
const maintenance=setInterval(()=>{void cache.maintain().catch(()=>{});},6*60*60*1000);maintenance.unref();
port.on('message',(message:{type:string;fix?:GeographicFix})=>{
  if(message.type==='stop') {clearInterval(maintenance);resolver.stop();port.close();}
  else if(message.type==='fix'&&message.fix)resolver.update(message.fix);
});
