import { EvenAppMethod, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type DeliveryAvailability = 'available' | 'unavailable' | 'unknown';
type CasePosition = 'inside' | 'outside' | 'unknown';
export interface AvailabilityChallenge { id: string }
type NativeBridge = Pick<EvenAppBridge, 'callEvenApp'>;
interface StatusEvent { connectType: string; isInCase?: boolean; isCharging?: boolean; sn?: string }
const availabilityByCase = {inside: 'unavailable', outside: 'available', unknown: 'unknown'} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The SDK supplies false for missing flags. Only a fresh, explicit case flag
 * from the connected G2 can select a destination, including after a restart. */
export class GlassesAvailability {
  private reportedCase: CasePosition = 'unknown';
  private serial?: string;
  private revision = 0;
  private lastEvent?: string;
  private readonly hints = new Map<string, {disconnected: boolean; inCase: boolean; until: number}>();
  private lastChallenge?: AvailabilityChallenge;
  private readonly caseChanged?: () => void;

  constructor(caseChanged?: () => void) { this.caseChanged = caseChanged; }
  get reportedCasePosition(): CasePosition { return this.reportedCase; }

  private showCase(position: CasePosition): void {
    if (this.reportedCase === position) return;
    this.reportedCase = position;
    this.lastEvent = undefined;
    this.caseChanged?.();
  }

  cancelReading(): void {
    this.revision++;
    this.lastChallenge = undefined;
    this.lastEvent = undefined;
  }

  invalidate(): void {
    this.cancelReading();
    this.hints.clear();
    this.serial = undefined;
    this.showCase('unknown');
  }

  private position(device: unknown): CasePosition {
    if (!object(device) || device.model !== 'g2' || !object(device.status) || device.status.connectType !== 'connected') {
      this.serial = undefined;
      return 'unknown';
    }
    const status = device.status;
    const serial = device.sn || status.sn;
    this.serial = typeof serial === 'string' && serial ? serial : undefined;
    // A native event may arrive just before the getter catches up. Ignore
    // other accessories and never make the user repeat a missed transition.
    let conflict = false;
    for (const [source, hint] of this.hints) {
      // A confirmed insertion event from this G2 cannot turn into evidence
      // of removal just because the getter disagreed for several seconds.
      const pairedInsertion = !!source && source === this.serial && hint.inCase;
      if (!pairedInsertion && hint.until <= performance.now()) { this.hints.delete(source); continue; }
      if (source && this.serial && source !== this.serial) continue;
      if (hint.disconnected) return 'unknown';
      if (status.isInCase === true) this.hints.delete(source);
      else conflict = true;
    }
    if (status.isInCase === true) return 'inside';
    if (status.isInCase === false && status.isCharging !== true && !conflict) return 'outside';
    return 'unknown';
  }

  async read(bridge: NativeBridge): Promise<DeliveryAvailability> {
    const revision = ++this.revision;
    let position: CasePosition = 'unknown';
    try {
      const device = await bridge.callEvenApp(EvenAppMethod.GetGlassesInfo);
      if (revision !== this.revision) return 'unknown';
      position = this.position(device);
    } catch {
      if (revision !== this.revision) return 'unknown';
      this.lastEvent = undefined;
    }
    this.showCase(position);
    return availabilityByCase[position];
  }

  refreshCase(bridge: NativeBridge): void { void this.read(bridge); }

  statusChanged(bridge: NativeBridge, status: StatusEvent): void {
    const source = status.sn || '';
    if (status.connectType !== 'connected' && !source) { this.invalidate(); return; }
    const key = JSON.stringify([source, status.connectType, status.isInCase, status.isCharging]);
    const caution = status.connectType !== 'connected' || status.isInCase === true || status.isCharging === true;
    if (caution) {
      if (this.hints.size >= 8 && !this.hints.has(source)) {
        for (const [id, hint] of this.hints) {
          if (id !== this.serial && (hint.until <= performance.now() || (this.serial && id))) this.hints.delete(id);
        }
        if (this.hints.size >= 8) { this.invalidate(); return; }
      }
      const inCase = status.isInCase === true || this.hints.get(source)?.inCase === true;
      this.hints.set(source, {disconnected: status.connectType !== 'connected', inCase, until: performance.now() + 2500});
      if (status.connectType !== 'connected' && source === this.serial) this.showCase('unknown');
    } else if (!this.hints.get(source)?.inCase || (status.isInCase === false && status.isCharging === false)) {
      this.hints.delete(source);
    }
    if (key === this.lastEvent) return;
    this.lastEvent = key;
    this.refreshCase(bridge);
  }

  async answer(challenge: AvailabilityChallenge, read: () => Promise<DeliveryAvailability>,
    current: () => boolean, post: (id: string, state: DeliveryAvailability) => Promise<unknown>): Promise<void> {
    if (this.lastChallenge?.id === challenge.id || !current()) return;
    const request = {id: challenge.id};
    this.lastChallenge = request;
    const state = await read();
    if (this.lastChallenge === request && current()) await post(request.id, state);
  }
}
