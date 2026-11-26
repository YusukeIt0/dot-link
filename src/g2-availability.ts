import { EvenAppMethod, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type DeliveryAvailability = 'available' | 'unavailable' | 'unknown';
export interface AvailabilityChallenge { id: string }
type NativeBridge = Pick<EvenAppBridge, 'callEvenApp'>;
interface StatusEvent { connectType: string; isWearing?: boolean; isInCase?: boolean; isCharging?: boolean; sn?: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The SDK maps absent wear and case fields to false. Read the published host
 * fields before that normalization. Keep only evidence for the current connection. */
export class GlassesAvailability {
  private observedWear = false;
  private casePosition: 'unknown' | 'inside' | 'outside' = 'unknown';
  private revision = 0;
  private eventState?: string;
  private lastChallenge?: AvailabilityChallenge;

  cancelReading(): void {
    this.revision++;
    this.eventState = undefined;
    this.lastChallenge = undefined;
  }

  invalidate(): void {
    this.cancelReading();
    this.forgetDevice();
  }

  private forgetDevice(): void {
    this.observedWear = false;
    this.casePosition = 'unknown';
  }

  private interpret(device: unknown, evidence?: StatusEvent | 'temple'): DeliveryAvailability {
    if (!object(device) || device.model !== 'g2' || !object(device.status)) {
      this.forgetDevice();
      return 'unknown';
    }
    const { connectType, isInCase, isWearing, isCharging } = device.status;
    if (connectType !== 'connected') {
      this.forgetDevice();
      return 'unknown';
    }
    if (isInCase === true || isCharging === true) {
      this.casePosition = isInCase === true ? 'inside' : 'unknown';
      return 'unavailable';
    }
    if (isInCase !== false || (isCharging !== undefined && typeof isCharging !== 'boolean') ||
        (isWearing !== undefined && typeof isWearing !== 'boolean')) {
      this.casePosition = 'unknown';
      return 'unknown';
    }
    if (isWearing === true) {
      this.observedWear = true;
      return 'available';
    }
    if (this.observedWear) return isWearing === false ? 'unavailable' : 'unknown';
    if (isCharging !== false) return 'unknown';
    // A getter alone has reported out-of-case with the lid closed. Confirm a
    // removal event against the G2 that produced this read, or a temple input.
    // Device identifiers are compared here only and never retained or sent.
    if (evidence === 'temple') this.casePosition = 'outside';
    else if (this.casePosition === 'inside' && evidence?.isInCase === false && evidence.isCharging === false &&
        evidence.sn && evidence.sn === (device.sn || device.status.sn)) this.casePosition = 'outside';
    return this.casePosition === 'outside' ? 'available' : 'unknown';
  }

  async read(bridge: NativeBridge, evidence?: StatusEvent | 'temple'): Promise<DeliveryAvailability> {
    const revision = ++this.revision;
    try {
      const device: unknown = await bridge.callEvenApp(EvenAppMethod.GetGlassesInfo);
      return this.revision === revision ? this.interpret(device, evidence) : 'unknown';
    } catch {
      if (this.revision === revision) this.forgetDevice();
      return 'unknown';
    }
  }

  templeInput(bridge: NativeBridge): void {
    if (!this.observedWear && this.casePosition !== 'outside') void this.read(bridge, 'temple');
  }

  statusChanged(bridge: NativeBridge, status: StatusEvent): void {
    if (status.connectType !== 'connected') { this.invalidate(); return; }
    const key = JSON.stringify([status.connectType, status.isWearing, status.isInCase, status.isCharging]);
    const removal = this.casePosition === 'inside' && status.isInCase === false && status.isCharging === false;
    if (key === this.eventState && !removal) return;
    this.eventState = key;
    this.revision++;
    if (status.isInCase === true || status.isCharging === true) {
      this.casePosition = 'unknown';
      void this.read(bridge);
    } else if (removal || (status.isWearing === true && !this.observedWear)) {
      void this.read(bridge, status);
    }
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
