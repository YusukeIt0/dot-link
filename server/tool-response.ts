/** Only feature-owned, fixed guidance may cross this boundary. */
export class ToolRejection extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ToolRejection';
    this.reason = reason;
  }
}

/** Invoke an already-selected tool; routing, validation and recovery stay outside. */
export async function toolResponse(action: () => unknown | Promise<unknown>) {
  try {
    const value = await action();
    return { result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
  } catch (error) {
    return error instanceof ToolRejection
      ? { error: { code: -32602, message: error.message, data: { reason: error.reason } } }
      : { error: { code: -32603, message: 'The operation could not be completed; an internal error occurred. Its outcome is not confirmed; do not change identifiers or content to force a retry.',
        data: { reason: 'internal_error' } } };
  }
}
