import { t } from './i18n.ts';

/** A response was received from the paired origin; not proof of a specific cause. */
export class RelayResponseError extends Error {
  constructor(message: string) { super(message); this.name = 'RelayResponseError'; }
}
export type ConnectionFailure = 'phone' | 'relay' | 'unreachable';

export function connectionFailure(error: unknown, online: boolean | undefined): ConnectionFailure {
  // An actual response is stronger evidence than the browser's connectivity hint.
  if (error instanceof RelayResponseError) return 'relay';
  return online === false ? 'phone' : 'unreachable';
}
export function connectionFailureCaption(reason: ConnectionFailure): string {
  return t(reason === 'phone' ? 'even.phone_offline' : reason === 'relay' ? 'even.mac_connection_error' : 'even.mac_unreachable');
}
export function connectionFailureHint(reason: ConnectionFailure): string {
  return t(reason === 'phone' ? 'even.check_phone_connection' : reason === 'relay' ? 'even.check_mac_dot_link' : 'even.check_phone_vpn_and_mac');
}
