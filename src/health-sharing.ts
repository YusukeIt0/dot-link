import type { TranslationKey } from './i18n.ts';
export interface HealthStatus {
  healthProtocol?: number; healthEpoch?: string | null; healthEnabled?: boolean; healthConfigured?: boolean;
  healthProfileRefreshAt?: string | null; healthPending?: boolean; healthStatus?: string; healthHasProfile?: boolean;
}
/** Temporary Polar or network failures that the Mac retries automatically. */
const RETRYING = ['HEALTH_REQUEST_FAILED', 'HEALTH_INVALID_RESPONSE', 'HEALTH_NETWORK_UNAVAILABLE', 'HEALTH_RATE_LIMITED'];
/** Message key for the companion's health status. Only failures that need the
 * owner point to the Mac's Healthcare settings; temporary ones say Dot Link retries. */
export function healthStatusKey(s: ReturnType<HealthSharing['status']>): TranslationKey {
  return s.failed ? 'even.health_failed' : !s.supported ? 'even.health_unavailable' :
    s.healthStatus === 'locked' ? 'even.health_locked' : !s.healthConfigured ? 'even.health_setup' :
    RETRYING.includes(s.healthStatus ?? '') ? 'even.health_retrying' :
    s.healthStatus?.startsWith('HEALTH_') || s.healthStatus === 'disconnect_pending' ? 'even.health_error' :
    s.pending || s.healthPending ? 'even.health_pending' : s.refreshed ? 'even.health_refreshed' : s.healthEnabled ? 'even.health_on' : 'even.health_off';
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
