import { EvenAppMethod, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type DeliveryAvailability = 'available' | 'unavailable' | 'unknown';
export interface AvailabilityChallenge { id: string }
type NativeBridge = Pick<EvenAppBridge, 'callEvenApp'>;
interface StatusEvent { connectType: string; isWearing?: boolean; isInCase?: boolean; isCharging?: boolean; sn?: string }

function eventKey(status: StatusEvent): string {
  return JSON.stringify([status.connectType, status.isWearing, status.isInCase, status.isCharging]);
}

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
  private readonly pendingEvents = new Map<string, StatusEvent>();
  private pendingTemple = false;
  private lastChallenge?: AvailabilityChallenge;

  private clearInputs(): void {
    this.pendingEvents.clear();
    this.pendingTemple = false;
  }

  cancelReading(): void {
    this.revision++;
    this.eventState = undefined;
    this.clearInputs();
    this.lastChallenge = undefined;
  }

  invalidate(): void {
    this.cancelReading();
    this.forgetDevice();
  }

  private forgetDevice(): void {
    this.observedWear = false;
    this.casePosition = 'unknown';
    this.clearInputs();
  }

  private interpret(device: unknown): DeliveryAvailability {
    if (!object(device) || device.model !== 'g2' || !object(device.status)) {
      this.forgetDevice();
      return 'unknown';
    }
    const { connectType, isInCase, isWearing, isCharging } = device.status;
    if (connectType !== 'connected') {
      this.forgetDevice();
      return 'unknown';
    }
    const serial = device.sn || device.status.sn;
    // Accessory events can arrive before the native getter finishes. Use the
    // latest event for each source. An unidentified negative event is a veto.
    const events = [...this.pendingEvents.values()].filter(status =>
      typeof serial !== 'string' || !serial || !status.sn || status.sn === serial);
    const lastEvent = events.at(-1);
    if (lastEvent) this.eventState = eventKey(lastEvent);
    if (events.some(status => status.connectType !== 'connected')) {
      this.forgetDevice();
      return 'unknown';
    }
    if (isInCase === true || isCharging === true) {
      this.casePosition = isInCase === true ? 'inside' : 'unknown';
      return 'unavailable';
    }
    if (events.some(status => status.isInCase === true || status.isCharging === true)) {
      this.casePosition = 'unknown';
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
    // The identifier is used only during this local observation.
    const removal = typeof serial === 'string' && serial ? this.pendingEvents.get(serial) : undefined;
    if (this.pendingTemple || (this.casePosition === 'inside' && removal?.isInCase === false && removal.isCharging === false))
      this.casePosition = 'outside';
    return this.casePosition === 'outside' ? 'available' : 'unknown';
  }

  async read(bridge: NativeBridge, evidence?: StatusEvent | 'temple'): Promise<DeliveryAvailability> {
    const revision = ++this.revision;
    if (evidence === 'temple') this.pendingTemple = true;
    else if (evidence) {
      const key = evidence.sn || '';
      // Bound transient data even if the host leaves a native call pending.
      if (!this.pendingEvents.has(key) && this.pendingEvents.size >= 8) {
        this.invalidate();
        return 'unknown';
      }
      this.pendingEvents.delete(key);
      this.pendingEvents.set(key, evidence);
    }
    try {
      const device: unknown = await bridge.callEvenApp(EvenAppMethod.GetGlassesInfo);
      if (this.revision !== revision) return 'unknown';
      // A send may start its own fresh getter before the event's getter
      // returns. Only the newest reading may consume the outstanding input.
      return this.interpret(device);
    } catch {
      if (this.revision === revision) this.forgetDevice();
      return 'unknown';
    } finally {
      if (this.revision === revision) this.clearInputs();
    }
  }

  templeInput(bridge: NativeBridge): void {
    if (!this.observedWear && this.casePosition !== 'outside') void this.read(bridge, 'temple');
  }

  statusChanged(bridge: NativeBridge, status: StatusEvent): void {
    if (status.connectType !== 'connected' && !status.sn) { this.invalidate(); return; }
    const key = eventKey(status);
    const removal = this.casePosition === 'inside' && status.isInCase === false && status.isCharging === false;
    const pending = this.pendingEvents.size > 0 || this.pendingTemple;
    if (key === this.eventState && !removal && !pending) return;
    this.eventState = undefined;
    this.revision++;
    if (status.connectType !== 'connected' || status.isInCase === true || status.isCharging === true ||
        pending || removal || (status.isWearing === true && !this.observedWear)) {
      void this.read(bridge, status);
    } else this.eventState = key;
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
