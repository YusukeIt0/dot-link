import { EvenAppMethod, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type DeliveryAvailability = 'available' | 'unavailable' | 'unknown';
type CasePosition = 'inside' | 'outside' | 'unknown';
export interface AvailabilityChallenge { id: string }
type NativeBridge = Pick<EvenAppBridge, 'callEvenApp'>;
interface StatusEvent { connectType: string; isWearing?: boolean; isInCase?: boolean; isCharging?: boolean; sn?: string }

function eventKey(status: StatusEvent): string {
  return JSON.stringify([status.connectType, status.isWearing, status.isInCase, status.isCharging]);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reportedPosition(value: unknown): CasePosition {
  return value === true ? 'inside' : value === false ? 'outside' : 'unknown';
}

function pairedReading(device: unknown, pending: Iterable<StatusEvent>) {
  if (!object(device) || device.model !== 'g2' || !object(device.status) || device.status.connectType !== 'connected') return;
  const serial = device.sn || device.status.sn;
  const events = [...pending].filter(status => typeof serial !== 'string' || !serial || !status.sn || status.sn === serial);
  return { status: device.status, serial, events, disconnected: events.some(status => status.connectType !== 'connected') };
}

/** The SDK maps absent wear and case fields to false. Read the published host
 * fields before that normalization. Keep only evidence for the current connection. */
export class GlassesAvailability {
  private observedWear = false;
  private casePosition: CasePosition = 'unknown'; // Corroborated evidence for delivery.
  private reportedCase: CasePosition = 'unknown';
  private reportedSerial?: string;
  private caseRevision = 0;
  private readonly caseChanged?: () => void;
  private revision = 0;
  private eventState?: string;
  private readonly pendingEvents = new Map<string, StatusEvent>();
  private pendingTemple = false;
  private lastChallenge?: AvailabilityChallenge;

  constructor(caseChanged?: () => void) { this.caseChanged = caseChanged; }
  get reportedCasePosition(): CasePosition { return this.reportedCase; }

  private showCase(position: CasePosition): void {
    if (this.reportedCase === position) return;
    this.reportedCase = position;
    this.caseChanged?.();
  }

  private async sample(bridge: NativeBridge, events: Iterable<StatusEvent>) {
    const revision = ++this.caseRevision;
    let reading: ReturnType<typeof pairedReading>;
    try {
      reading = pairedReading(await bridge.callEvenApp(EvenAppMethod.GetGlassesInfo), events);
      return reading;
    } finally {
      // The phone shows the host's explicit case flag, even when delivery needs more evidence.
      if (revision === this.caseRevision) {
        this.reportedSerial = typeof reading?.serial === 'string' ? reading.serial : undefined;
        this.showCase(reportedPosition(reading?.disconnected ? undefined : reading?.status.isInCase));
      }
    }
  }

  refreshCase(bridge: NativeBridge, events: StatusEvent[] = []): void {
    if (this.caseChanged) void this.sample(bridge, events).catch(() => { /* A failed read already cleared the label. */ });
  }

  private clearInputs(): void {
    this.pendingEvents.clear();
    this.pendingTemple = false;
  }

  cancelReading(): void {
    this.revision++;
    this.caseRevision++;
    this.eventState = undefined;
    this.clearInputs();
    this.lastChallenge = undefined;
  }

  invalidate(): void {
    this.cancelReading();
    this.forgetDevice();
    this.reportedSerial = undefined;
    this.showCase('unknown');
  }

  private forgetDevice(): void {
    this.observedWear = false;
    this.casePosition = 'unknown';
    this.clearInputs();
  }

  private interpret(reading: ReturnType<typeof pairedReading>): DeliveryAvailability {
    if (!reading) {
      this.forgetDevice();
      return 'unknown';
    }
    const { status: {isInCase, isWearing, isCharging}, serial, events } = reading;
    // Accessory events can arrive before the native getter finishes. Use the
    // latest event for each source. An unidentified negative event is a veto.
    const lastEvent = events.at(-1);
    if (lastEvent) this.eventState = eventKey(lastEvent);
    if (reading.disconnected) {
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
      const reading = await this.sample(bridge, this.pendingEvents.values());
      if (this.revision !== revision) return 'unknown';
      // A send may start its own fresh getter before the event's getter
      // returns. Only the newest reading may consume the outstanding input.
      return this.interpret(reading);
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
    if (status.connectType !== 'connected' && status.sn === this.reportedSerial) {
      this.caseRevision++;
      this.showCase('unknown');
    }
    const key = eventKey(status);
    const removal = this.casePosition === 'inside' && status.isInCase === false && status.isCharging === false;
    const pending = this.pendingEvents.size > 0 || this.pendingTemple;
    if (key === this.eventState && !removal && !pending) return;
    this.eventState = undefined;
    this.revision++;
    if (status.connectType !== 'connected' || status.isInCase === true || status.isCharging === true ||
        pending || removal || (status.isWearing === true && !this.observedWear)) {
      void this.read(bridge, status);
    } else {
      this.eventState = key;
      // An ordinary case change can need a new phone label without qualifying as delivery evidence.
      this.refreshCase(bridge, [status]);
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
