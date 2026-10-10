import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Bridge, eventDefinition, replyTool, statusTool, pendingTool, sendMessageTool } from './bridge.ts';
import { CallbackDestinationError, CallbackVerificationError } from './webhook.ts';
import { NotificationInbox, notificationEvent, pendingNotificationsTool, announceNotificationTool, notificationDispositionTool } from './notifications.ts';

const rpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() }).strict();

export async function rpc(bridge: Bridge, raw: unknown, notifications?: NotificationInbox): Promise<unknown> {
  const parsed = rpcSchema.safeParse(raw);
  if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const { id, method, params } = parsed.data;
  if (id === undefined) return undefined;
  try {
    let result: unknown;
    switch (method) {
      case 'server/discover': result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} }, serverInfo: { name: 'even-g2-dot', version: '0.1.0' } }; break;
      case 'initialize': result = { protocolVersion: '2025-11-25', serverInfo: { name: 'even-g2-dot', version: '0.1.0' }, capabilities: { tools: {}, experimental: { events: {} } } }; break;
      case 'ping': result = {}; break;
      case 'events/list': result = { events: [eventDefinition, ...(notifications ? [notificationEvent] : [])] }; break;
      case 'events/subscribe': result = notifications && (params as { name?: string })?.name === 'notification.created' ? await notifications.subscribe(params) : await bridge.subscribe(params); break;
      case 'events/unsubscribe': result = notifications && (params as { name?: string })?.name === 'notification.created' ? await notifications.unsubscribe(params) : await bridge.unsubscribe(params); break;
      case 'tools/list': result = { tools: [statusTool, pendingTool, replyTool, sendMessageTool, ...(notifications ? [pendingNotificationsTool, announceNotificationTool, notificationDispositionTool] : [])] }; break;
      case 'tools/call': {
        if ((params as { name?: string })?.name === 'send_message_to_g2') {
          const input = z.object({ name: z.literal('send_message_to_g2'), arguments: z.unknown() }).parse(params);
          const value = await bridge.sendMessage(input.arguments);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break;
        }
        if (notifications && (params as { name?: string })?.name === 'get_pending_notifications') {
          const input = z.object({ name: z.literal('get_pending_notifications'), arguments: z.unknown().optional() }).parse(params);
          const value = notifications.pending(input.arguments);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break;
        }
        if (notifications && (params as { name?: string })?.name === 'set_notification_disposition') {
          const input = z.object({ name: z.literal('set_notification_disposition'), arguments: z.unknown() }).parse(params);
          const value = await notifications.decide(input.arguments);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break;
        }
        if (notifications && (params as { name?: string })?.name === 'announce_notification_to_g2') {
          const input = z.object({ name: z.literal('announce_notification_to_g2'), arguments: z.unknown() }).parse(params);
          const value = await notifications.announce(input.arguments);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break;
        }
        // MCP envelopes may contain metadata such as _meta/progressToken.
        // Ignore envelope extensions; validate the actual tool arguments strictly.
        const statusCall = z.object({ name: z.enum(['get_status', 'get_pending_utterances']), arguments: z.object({}).strict().optional() }).safeParse(params);
        if (statusCall.success) {
          const status = statusCall.data.name === 'get_status' ? { ...bridge.status(), ...(notifications?.status() ?? {}) } : bridge.pending();
          result = { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status }; break;
        }
        const input = z.object({ name: z.literal('reply_to_g2'), arguments: z.unknown() }).parse(params);
        const reply = await bridge.reply(input.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(reply) }], structuredContent: reply }; break;
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    // Never include input, callback secrets, or user text in error responses/logs.
    if (error instanceof CallbackDestinationError) console.warn(JSON.stringify({ event: 'callback_host_rejected', hostname: error.hostname }));
    if (error instanceof CallbackVerificationError) return { jsonrpc: '2.0', id, error: { code: -32015, message: 'CallbackEndpointError', data: { reason: 'challenge_failed' } } };
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Request rejected; check parameters, subscription, and callback verification' } };
  }
}

export function authorized(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const a = Buffer.from(value); const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function bridgeServer(bridge: Bridge, tokens: { mcp: string; device: string; notification?: string }, notifications?: NotificationInbox) {
  if (tokens.mcp.length < 32 || tokens.device.length < 32 || tokens.mcp === tokens.device) throw new Error('Use distinct bridge tokens of at least 32 characters');
  if (notifications && (!tokens.notification || tokens.notification.length < 32 || [tokens.mcp, tokens.device].includes(tokens.notification))) throw new Error('Use a distinct notification ingestion token');
  const instance = randomUUID();
  let revision = 0;
  const waiting = new Set<() => void>();
  const changed = () => { revision++; for (const wake of [...waiting]) wake(); };
  const unsubscribeBridge = bridge.changes.subscribe(changed);
  const unsubscribeNotifications = notifications?.changes.subscribe(changed);
  const cursor = () => `${instance}:${revision}`;
  const history = () => [...bridge.history(), ...bridge.outboundHistory(), ...(notifications?.history() ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  const snapshot = () => ({ revision: cursor(), status: { ...bridge.status(), ...(notifications?.status() ?? {}) }, messages: history() });
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, data?: unknown) => { response.writeHead(status); response.end(data === undefined ? undefined : JSON.stringify(data)); };
    // Intended for private access through a tunnel. No browser cross-origin access.
    if (request.headers.origin) { send(403, { error: 'Browser origin not enabled' }); return; }
    // This bridge uses static credentials, not OAuth. Missing metadata and
    // other unknown routes must be 404 rather than an authentication challenge.
    if (!['/mcp', '/api/status', '/api/messages', '/api/updates', '/api/utterances', '/api/timings', ...(notifications ? ['/api/notifications', '/api/notifications/status'] : [])].includes(request.url ?? '')) {
      send(404, { error: 'Not found' }); return;
    }
    const token = request.url === '/mcp' ? tokens.mcp : ['/api/notifications', '/api/notifications/status'].includes(request.url ?? '') ? tokens.notification! : tokens.device;
    if (!authorized(request.headers.authorization, token)) { send(401, { error: 'Unauthorized' }); return; }
    try {
      if (request.url === '/api/status' && request.method === 'GET') { send(200, { ...bridge.status(), ...(notifications?.status() ?? {}) }); return; }
      if (request.url === '/api/messages' && request.method === 'GET') {
        const messages = history();
        response.once('finish', () => notifications?.markClientResponse(messages.map(n => n.id)));
        send(200, messages); return;
      }
      if (notifications && request.url === '/api/notifications/status' && request.method === 'POST') {
        send(200, notifications.deliveryStatus(await body(request))); return;
      }
      if (request.url === '/api/updates' && request.method === 'GET') {
        const after = request.headers['x-g2-revision'];
        if (after !== undefined && (typeof after !== 'string' || !/^[0-9a-f-]{36}:\d{1,12}$/.test(after))) { send(400, { error: 'Invalid revision' }); return; }
        if (after === cursor()) {
          if (waiting.size >= 8) { send(503, { error: 'Too many waiting clients' }); return; }
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); waiting.delete(finish); response.off('close', finish); resolve(); };
            const timer = setTimeout(finish, 15_000);
            waiting.add(finish); response.once('close', finish);
            if (after !== cursor() || response.destroyed) finish();
          });
        }
        if (!response.destroyed) {
          const value = snapshot();
          response.once('finish', () => notifications?.markClientResponse(value.messages.map(n => n.id)));
          send(200, value);
        }
        return;
      }
      if (request.url === '/api/timings' && request.method === 'POST') { bridge.latency.client(await body(request)); send(204); return; }
      if (request.url === '/api/utterances' && request.method === 'POST') { send(200, await bridge.submit(await body(request))); return; }
      if (notifications && request.url === '/api/notifications' && request.method === 'POST') { send(200, await notifications.submit(await body(request))); return; }
      if (request.url === '/mcp' && request.method === 'POST') {
        const result = await rpc(bridge, await body(request), notifications); send(result === undefined ? 202 : 200, result); return;
      }
      if (request.url === '/mcp') { response.setHeader('Allow', 'POST'); send(405, { error: 'Method not allowed' }); return; }
      send(404, { error: 'Not found' });
    } catch { send(400, { error: 'Request rejected; no successful delivery is implied' }); }
  });
  server.once('close', () => { unsubscribeBridge(); unsubscribeNotifications?.(); for (const wake of [...waiting]) wake(); });
  return server;
}
