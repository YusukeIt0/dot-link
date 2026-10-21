/** Wire contract for connection ownership, independent of the AI transport. */
export type RuntimeRecoveryRequest =
  | { action: 'inspect' }
  | { action: 'claim'; id: string; expectedGeneration: number }
  | { action: 'renew'; id: string; generation: number };

export const RUNTIME_RECOVERY_PROTOCOL = 1;
export const RUNTIME_SUPERSEDED = 'runtime_superseded';
export const runtimeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
export const runtimeGeneration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;

export function runtimeRecoveryRequest(value: unknown): RuntimeRecoveryRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.action === 'inspect' && Object.keys(input).length === 1) return { action: 'inspect' };
  if (Object.keys(input).length !== 3 || !runtimeId(input.id)) return;
  if (input.action === 'claim' && runtimeGeneration(input.expectedGeneration)) {
    return { action: 'claim', id: input.id, expectedGeneration: input.expectedGeneration };
  }
  if (input.action === 'renew' && runtimeGeneration(input.generation) && input.generation > 0) {
    return { action: 'renew', id: input.id, generation: input.generation };
  }
}
