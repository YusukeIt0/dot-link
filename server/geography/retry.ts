/** Acquisition errors and worker crashes share the same bounded retry cadence. */
export const geographicRetryDelay=(failures:number)=>Math.min(3_600_000,60_000*2**Math.min(6,Math.max(0,failures-1)));
