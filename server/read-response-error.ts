import { ToolRejection } from './tool-response.ts';

export class ReadResponseError extends ToolRejection {
  constructor() {
    super('invalid_arguments', 'Read arguments are invalid. Use the selected tool schema to correct them.');
  }
}
