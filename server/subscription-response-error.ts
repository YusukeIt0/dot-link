import { z } from 'zod';
import { ToolRejection, rpcResponse } from './tool-response.ts';
import { callbackUrl, signingSecret, CallbackDestinationError, CallbackVerificationError } from './webhook.ts';

const messages = {
  invalid_arguments: 'Subscription arguments are invalid. Use the selected event schema to correct them.',
  callback_destination_rejected: 'The callback URL is invalid or not allowed. Use an allowed HTTPS callback destination.',
  invalid_signing_secret: 'The webhook signing secret is invalid. Supply a valid webhook signing secret.',
  subscription_conflict: 'Another callback is already subscribed. Keep the existing subscription unless replacing it is intended; unsubscribe it before replacing it.',
} as const;

export class SubscriptionResponseError extends ToolRejection {
  constructor(reason: keyof typeof messages) { super(reason, messages[reason]); }
}

/** Called only at the subscription input boundary, never around execution. */
export function subscriptionArguments<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new SubscriptionResponseError('invalid_arguments');
  return parsed.data;
}

export function subscriptionDelivery(delivery: { url: string; secret: string }, hosts: readonly string[]) {
  try { callbackUrl(delivery.url, hosts); }
  catch (error) {
    if (error instanceof CallbackDestinationError) {
      // Preserve existing operator diagnostics, never the URL or signing secret.
      console.warn(JSON.stringify({ event: 'callback_host_rejected', hostname: error.hostname }));
    } else if (!(error instanceof TypeError)) throw error;
    throw new SubscriptionResponseError('callback_destination_rejected');
  }
  try { signingSecret(delivery.secret); }
  catch { throw new SubscriptionResponseError('invalid_signing_secret'); }
}

export function subscriptionResponse(action: () => unknown | Promise<unknown>) {
  return rpcResponse(async () => {
    try { return await action(); }
    catch (error) {
      if (error instanceof CallbackVerificationError) {
        throw new ToolRejection('challenge_failed', 'CallbackEndpointError', -32015);
      }
      throw error;
    }
  });
}
