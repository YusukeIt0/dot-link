export interface HealthStatus {
  healthProtocol?: number; healthEpoch?: string | null; healthEnabled?: boolean; healthConfigured?: boolean;
  healthProfileRefreshAt?: string | null; healthPending?: boolean; healthStatus?: string; healthHasProfile?: boolean;
}
/** Acknowledged Mac consent only; never infer success while offline. */
export class HealthSharing {
  private value: HealthStatus = {};
  private origin?: string;
  private received = -Infinity;
  private pending = false;
  private failed = false;
  private generation = 0;
  private refreshBefore?: string | null;
  private refreshed = false;
  private options: {target: () => string | undefined; api: (input: unknown) => Promise<unknown>; changed: () => void; now?: () => number};
  constructor(options: HealthSharing['options']) { this.options = options; }
  receive(value: HealthStatus) { if(this.refreshBefore!==undefined&&value.healthProfileRefreshAt&&value.healthProfileRefreshAt!==this.refreshBefore){this.refreshed=true;this.refreshBefore=undefined;} this.value=value; this.origin=this.options.target(); this.received=this.now(); this.options.changed(); }
  private now() { return (this.options.now??Date.now)(); }
  reset() { this.generation++; this.value={}; this.origin=undefined; this.received=-Infinity; this.pending=false; this.failed=false; this.refreshed=false; this.refreshBefore=undefined; this.options.changed(); }
  status() {
    const connected=!!this.origin&&this.origin===this.options.target()&&this.now()-this.received<45_000;
    return {...(connected?this.value:{}),supported:connected&&this.value.healthProtocol===1&&typeof this.value.healthEpoch==='string',pending:this.pending,failed:this.failed,refreshed:this.refreshed};
  }
  async control(action:'enable'|'disable'|'delete'|'refresh') {
    const state=this.status(),target=this.options.target(),generation=this.generation;
    if(this.pending)return;
    if(!state.supported||!target){this.failed=true;this.options.changed();return;}
    this.pending=true;this.failed=false;this.refreshed=false;if(action==='refresh')this.refreshBefore=this.value.healthProfileRefreshAt??null;this.options.changed();
    try {
      const result=await this.options.api({protocol:1,epoch:state.healthEpoch,action});
      if(target===this.options.target()&&generation===this.generation)this.receive(result as HealthStatus);
    }catch{if(target===this.options.target()&&generation===this.generation)this.failed=true;}
    finally{if(generation===this.generation){this.pending=false;this.options.changed();}}
  }
}
