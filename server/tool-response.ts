/** Only feature-owned, fixed guidance may cross this boundary. */
export class ToolRejection extends Error {
  readonly reason: string;
  readonly code: number;
  constructor(reason: string, message: string, code = -32602) {
    super(message);
    this.name = 'ToolRejection';
    this.reason = reason;
    this.code = code;
  }
}

/** Invoke an already-selected tool; routing, validation and recovery stay outside. */
export async function rpcResponse(action: () => unknown | Promise<unknown>) {
  try {
    return { result: await action() };
  } catch (error) {
    return error instanceof ToolRejection
      ? { error: { code: error.code, message: error.message, data: { reason: error.reason } } }
      : { error: { code: -32603, message: 'The operation could not be completed; an internal error occurred. Its outcome is not confirmed; do not change identifiers or content to force a retry.',
        data: { reason: 'internal_error' } } };
  }
}

export function toolResponse(action: () => unknown | Promise<unknown>) {
  return rpcResponse(async () => {
    const value = await action();
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  });
}
