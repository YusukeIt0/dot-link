import { EvenAppMethod, type EvenAppBridge } from '@evenrealities/even_hub_sdk';

export type DeliveryAvailability = 'available' | 'unavailable' | 'unknown';
export interface AvailabilityChallenge { id: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The SDK maps absent wear and case fields to false. Read the published host
 * fields before that normalization. Keep only a capability bit for this connection. */
export class GlassesAvailability {
  private observedWear = false;
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
    this.observedWear = false;
  }

  private interpret(device: unknown): DeliveryAvailability {
    if (!object(device) || device.model !== 'g2' || !object(device.status)) return 'unknown';
    const { connectType, isInCase, isWearing, isCharging } = device.status;
    if (connectType !== 'connected') {
      this.observedWear = false;
      return 'unknown';
    }
    if (isInCase === true || isCharging === true) return 'unavailable';
    if (isInCase !== false || (isCharging !== undefined && typeof isCharging !== 'boolean')) return 'unknown';
    if (isWearing === true) {
      this.observedWear = true;
      return 'available';
    }
    // On Even iOS 2.4.1 a fresh lookup selected G2 while the case stayed
    // closed. An explicit false case field alone cannot establish removal.
    return isWearing === false && this.observedWear ? 'unavailable' : 'unknown';
  }

  async read(bridge: Pick<EvenAppBridge, 'callEvenApp'>): Promise<DeliveryAvailability> {
    const revision = ++this.revision;
    try {
      const device: unknown = await bridge.callEvenApp(EvenAppMethod.GetGlassesInfo);
      return this.revision === revision ? this.interpret(device) : 'unknown';
    } catch { return 'unknown'; }
  }

  statusChanged(bridge: Pick<EvenAppBridge, 'callEvenApp'>, status: { connectType: string; isWearing?: boolean; isInCase?: boolean; isCharging?: boolean }): void {
    // An event may describe a ring. Only the model-specific lookup can establish wear.
    const key = JSON.stringify([status.connectType, status.isWearing, status.isInCase, status.isCharging]);
    if (key === this.eventState) return;
    this.eventState = key;
    this.revision++;
    if (status.connectType !== 'connected' || (status.isWearing === true && !this.observedWear)) void this.read(bridge);
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
