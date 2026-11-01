import { createServer } from 'node:http';
import { z } from 'zod';
import { authorized, rpc } from '../server/http.ts';
import type { Bridge } from '../server/bridge.ts';
import type { HistoryReader } from '../server/history/tool.ts';

const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
  method: z.string(), params: z.unknown().optional() }).strict();

/** Read-only synthetic surface. Production entry points never import this module. */
export function historyPreviewServer(bridge: Bridge, token: string, history: HistoryReader) {
  if (token.length < 32) throw new Error('A separate preview credential is required');
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, value?: unknown) => { response.writeHead(status); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (request.headers.origin) { send(403, { error: 'Browser origin not enabled' }); return; }
    if (request.url !== '/mcp') { send(404); return; }
    if (!authorized(request.headers.authorization, token)) { send(401); return; }
    if (request.method !== 'POST') { send(405); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32_768) { send(413); return; }
        chunks.push(chunk);
      }
      const parsed = envelope.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success) { send(400, { error: 'Invalid request' }); return; }
      const input = parsed.data;
      if (input.id === undefined) { send(202); return; }
      const reject = () => send(200, { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'This isolated fixture supports history reads only.' } });
      if (input.method === 'events/list') { send(200, { jsonrpc: '2.0', id: input.id, result: { events: [] } }); return; }
      if (input.method === 'tools/call') {
        const call = z.object({ name: z.literal('get_location_history') }).safeParse(input.params);
        if (!call.success) { reject(); return; }
      } else if (!['server/discover', 'initialize', 'ping', 'tools/list'].includes(input.method)) { reject(); return; }
      const result = await rpc(bridge, input, undefined, undefined, history) as { result?: Record<string, any> };
      if (input.method === 'tools/list' && result.result) result.result.tools = result.result.tools
        .filter((tool: { name: string }) => tool.name === 'get_location_history')
        .map((tool: {description: string}) => ({...tool, description: 'Isolated fictional test data, never the owner’s actual experiences. This connection has no reply tool; answer in the ordinary conversation. ' + tool.description}));
      if (result.result?.serverInfo) result.result.serverInfo = { ...result.result.serverInfo, name: 'dot-link-synthetic-history-preview' };
      send(200, result);
    } catch { send(400, { error: 'Invalid preview request' }); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
