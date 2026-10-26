import { parentPort, workerData } from 'node:worker_threads';
import { GeographicCache } from './cache.ts';
import { GeographicResolver } from './resolver.ts';
import type { GeographicFix } from './types.ts';

if(!parentPort)throw new Error('Geography worker needs a parent');
const port=parentPort;
const resolver=new GeographicResolver({cache:new GeographicCache(workerData.directory),output:result=>port.postMessage(result)});
port.on('message',(message:{type:string;fix?:GeographicFix})=>{
  if(message.type==='stop') {resolver.stop();port.close();}
  else if(message.type==='fix'&&message.fix)resolver.update(message.fix);
});
