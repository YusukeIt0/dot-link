export interface PairingStatus {
  evenPairingKnown: boolean;
  evenPaired: boolean;
  evenPairingCount: number;
  evenInvitationCount: number;
}
export function pairingStatus(directory: string, now?: number): Promise<PairingStatus>;
