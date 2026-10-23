import type { RelayCredentials } from './relay-connection.ts';
import type { RelaySession } from './relay-session.ts';

interface Options {
  session: Pick<RelaySession, 'credentials' | 'restart' | 'use' | 'save' | 'forget'>;
  stopUpdates: () => void;
  cancelPlayback: () => void;
  stopLocation: () => void;
  clearLegacyPairing: () => void;
  resetInteraction: (pairing: boolean, newIdentity: boolean) => void;
  resetConversation: () => void;
  resetDelivery: (origin: string | undefined, clearRetry: boolean) => void;
  resetConnectionInfo: () => void;
}

/** Application reset policy; transport generations remain owned by RelaySession. */
export class ConnectionTransitions {
  private options: Options;
  constructor(options: Options) { this.options = options; }

  beginPairing(): void { this.restart(); }

  restore(saved: RelayCredentials | undefined): void {
    const sameOrigin = !!saved && saved.origin === this.options.session.credentials?.origin;
    this.restart();
    this.options.session.use(saved);
    this.reset(false, !sameOrigin, saved?.origin);
  }

  paired(credentials: RelayCredentials): boolean {
    const retained = this.options.session.save(credentials);
    this.options.clearLegacyPairing();
    this.reset(true, true, credentials.origin);
    return retained;
  }

  forget(persist = true): void {
    // Revoke using the old destination before removing its credentials.
    this.options.stopLocation();
    this.restart();
    this.options.session.forget(persist);
    this.options.clearLegacyPairing();
    this.reset(false, true, undefined);
  }

  private restart(): void {
    this.options.stopUpdates(); this.options.session.restart(); this.options.cancelPlayback();
  }
  private reset(pairing: boolean, newIdentity: boolean, origin: string | undefined): void {
    this.options.resetInteraction(pairing, newIdentity);
    if (newIdentity) this.options.resetConversation();
    this.options.resetDelivery(origin, newIdentity);
    this.options.resetConnectionInfo();
  }
}
