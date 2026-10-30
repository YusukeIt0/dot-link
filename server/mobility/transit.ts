import {MobilityNetwork} from './network.ts';
import {EnturProvider,inEnturSearchArea} from './entur.ts';
import {VbbProvider,inVbbSearchArea} from './vbb.ts';
import {validPoint,type Point} from './terrain.ts';
export class RegionalTransitProvider {
  private readonly entur:EnturProvider;
  private readonly vbb:VbbProvider;
  constructor(network:MobilityNetwork){this.entur=new EnturProvider(network);this.vbb=new VbbProvider(network);}
  async plan(origin:Point,destination:Point,departure:string,signal:AbortSignal){
    if(!validPoint(origin)||!validPoint(destination)||!Number.isFinite(Date.parse(departure)))throw new Error('Invalid transit query');
    signal.throwIfAborted();
    if(inEnturSearchArea(origin)&&inEnturSearchArea(destination))return this.entur.plan(origin,destination,departure,signal);
    if(inVbbSearchArea(origin)&&inVbbSearchArea(destination))return this.vbb.plan(origin,destination,departure,signal);
    return {status:'outside_source_coverage',candidates:[],source:null,
      coverage:'Configured sources cover Norway and Berlin/Brandenburg; no query was made outside those search areas.',
      requested_departure:departure,retrieved_at:new Date().toISOString(),
      limitations:['Regional source coverage is incomplete. Other public transport may exist; do not infer its absence or ask the owner to register for an API.']};
  }
}
