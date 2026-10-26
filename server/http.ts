import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { Bridge, eventDefinition, replyTool, statusTool, pendingTool, sendMessageTool } from './bridge.ts';
import { NotificationInbox, notificationEvent, pendingNotificationsTool, announceNotificationTool, notificationDispositionTool } from './notifications.ts';
import { LocationContext, locationEvent, locationContextTool, locationResponseTool } from './location.ts';
import { LocationResponseError } from './location-response-error.ts';
import { PhotoStorageFullError } from './photo-attachments.ts';
import { PHOTO_REQUEST_BYTES } from '../src/photo-attachments.ts';
import { toolResponse, rpcResponse, ToolRejection } from './tool-response.ts';
import { ReadResponseError } from './read-response-error.ts';
import { subscriptionResponse } from './subscription-response-error.ts';

const { version: packageVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const rpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() }).strict();

export async function rpc(bridge: Bridge, raw: unknown, notifications?: NotificationInbox, locations?: LocationContext): Promise<unknown> {
  const parsed = rpcSchema.safeParse(raw);
  if (!parsed.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const { id, method, params } = parsed.data;
  if (id === undefined) return undefined;
  try {
    let result: unknown;
    switch (method) {
      case 'server/discover': result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} }, serverInfo: { name: 'even-g2-dot', version: packageVersion } }; break;
      case 'initialize': result = { protocolVersion: '2025-11-25', serverInfo: { name: 'even-g2-dot', version: packageVersion }, capabilities: { tools: {}, experimental: { events: {} } } }; break;
      case 'ping': result = {}; break;
      case 'events/list': result = { events: [eventDefinition, ...(notifications ? [notificationEvent] : []), ...(locations ? [locationEvent] : [])] }; break;
      case 'events/subscribe':
      case 'events/unsubscribe': {
        const p = z.object({ name: z.string().min(1) }).safeParse(params);
        if (!p.success) throw new ToolRejection('invalid_arguments', 'Specify an event name from events/list.');
        const { name } = p.data;
        if (!['utterance.created', 'notification.created', 'location.updated'].includes(name)) {
          throw new ToolRejection('unknown_event', 'The event is unknown. Refresh events/list and select an available event.');
        }
        const feature = name === 'utterance.created' ? bridge : name === 'notification.created' ? notifications : locations;
        if (!feature) throw new ToolRejection('event_unavailable', 'The event is unavailable. Refresh events/list and use an available event.');
        return { jsonrpc: '2.0', id, ...await subscriptionResponse(() =>
          method === 'events/subscribe' ? feature.subscribe(params) : feature.unsubscribe(params)) };
      }
      case 'tools/list': result = { tools: [statusTool, pendingTool, replyTool, sendMessageTool, ...(notifications ? [pendingNotificationsTool, announceNotificationTool, notificationDispositionTool] : []), ...(locations ? [locationContextTool, locationResponseTool] : [])] }; break;
      case 'tools/call': {
        // MCP envelopes may contain _meta/progressToken; feature arguments stay strict.
        const parsedCall = z.object({ name: z.string().min(1), arguments: z.unknown().optional() }).safeParse(params);
        if (!parsedCall.success) throw new ToolRejection('invalid_arguments', 'Specify a tool name from tools/list.');
        const { name, arguments: args } = parsedCall.data;
        const notificationNames = ['get_pending_notifications', 'set_notification_disposition', 'announce_notification_to_g2'];
        const locationNames = ['get_location_context', 'respond_to_location'];
        if (![...notificationNames, ...locationNames, 'get_status', 'get_pending_utterances', 'send_message_to_g2', 'reply_to_g2'].includes(name)) {
          throw new ToolRejection('unknown_tool', 'The tool is unknown. Refresh tools/list and select an available tool.');
        }
        if ((!notifications && notificationNames.includes(name)) || (!locations && locationNames.includes(name))) {
          throw new ToolRejection('tool_unavailable', 'The tool is unavailable. Refresh tools/list and use an available tool.');
        }
        if (name === 'respond_to_location') {
          const value = await locations!.respond(args);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; break;
        }
        if (name === 'get_pending_utterances') {
          return { jsonrpc: '2.0', id, ...await rpcResponse(() => bridge.pendingResult(args)) };
        }
        return { jsonrpc: '2.0', id, ...await toolResponse(() => {
          switch (name) {
            case 'get_status': {
              if (!z.object({}).strict().safeParse(args === undefined ? {} : args).success) throw new ReadResponseError();
              return { ...bridge.status(), ...(notifications?.status() ?? {}), ...(locations?.status() ?? {}) };
            }
            case 'get_pending_notifications': return notifications!.pending(args);
            case 'get_location_context': return locations!.read(args);
            case 'send_message_to_g2': return bridge.sendMessage(args);
            case 'reply_to_g2': return bridge.reply(args);
            case 'set_notification_disposition': return notifications!.decide(args);
            case 'announce_notification_to_g2': return notifications!.announce(args);
          }
        }) };
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    // Never include input, callback secrets, or user text in error responses/logs.
    if (error instanceof ToolRejection && !(locations && method === 'tools/call' && (params as { name?: string })?.name === 'respond_to_location')) {
      return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: { reason: error.reason } } };
    }
    if (locations && method === 'tools/call' && (params as { name?: string })?.name === 'respond_to_location') {
      const rejection = error instanceof LocationResponseError ? error : new LocationResponseError('internal_error');
      return { jsonrpc: '2.0', id, error: { code: rejection.reason === 'internal_error' ? -32603 : -32602,
        message: rejection.message, data: { reason: rejection.reason } } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Request rejected; check parameters, subscription, and callback verification' } };
  }
}

export function authorized(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const a = Buffer.from(value); const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(request: IncomingMessage, limit = 32768): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function bridgeServer(bridge: Bridge, tokens: { mcp: string; device: string; notification?: string }, notifications?: NotificationInbox, locations?: LocationContext) {
  if (tokens.mcp.length < 32 || tokens.device.length < 32 || tokens.mcp === tokens.device) throw new Error('Use distinct bridge tokens of at least 32 characters');
  if (notifications && (!tokens.notification || tokens.notification.length < 32 || [tokens.mcp, tokens.device].includes(tokens.notification))) throw new Error('Use a distinct notification ingestion token');
  const instance = randomUUID();
  let revision = 0;
  const waiting = new Set<() => void>();
  const changed = () => { revision++; for (const wake of [...waiting]) wake(); };
  const unsubscribeBridge = bridge.changes.subscribe(changed);
  const unsubscribeNotifications = notifications?.changes.subscribe(changed);
  const unsubscribeLocations = locations?.changes.subscribe(changed);
  const cursor = () => `${instance}:${revision}`;
  const history = () => [...bridge.history(), ...bridge.outboundHistory(), ...(notifications?.history() ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  const deviceStatus = () => ({ ...bridge.status(), photoAttachments: 1, ...(notifications?.status() ?? {}), ...(locations?.status() ?? {}) });
  const snapshot = () => ({ revision: cursor(), status: deviceStatus(), messages: history() });
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, data?: unknown) => { response.writeHead(status); response.end(data === undefined ? undefined : JSON.stringify(data)); };
    // Intended for private access through a tunnel. No browser cross-origin access.
    if (request.headers.origin) { send(403, { error: 'Browser origin not enabled' }); return; }
    // This bridge uses static credentials, not OAuth. Missing metadata and
    // other unknown routes must be 404 rather than an authentication challenge.
    if (!['/mcp', '/api/status', '/api/messages', '/api/updates', '/api/utterances', '/api/timings', ...(notifications ? ['/api/notifications', '/api/notifications/status'] : []), ...(locations ? ['/api/location/control', '/api/location/update', '/api/location/revoke'] : [])].includes(request.url ?? '')) {
      send(404, { error: 'Not found' }); return;
    }
    const token = request.url === '/mcp' ? tokens.mcp : ['/api/notifications', '/api/notifications/status'].includes(request.url ?? '') ? tokens.notification! : tokens.device;
    if (!authorized(request.headers.authorization, token)) { send(401, { error: 'Unauthorized' }); return; }
    try {
      if (request.url === '/api/status' && request.method === 'GET') { send(200, deviceStatus()); return; }
      if (locations && request.method === 'POST' && ['/api/location/control', '/api/location/update', '/api/location/revoke'].includes(request.url ?? '')) {
        const owner = request.headers['x-g2-location-owner'];
        if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) { send(400, { error: 'Device subject required' }); return; }
        const input = await body(request);
        if (request.url === '/api/location/revoke') { z.object({}).strict().parse(input); send(200, locations.revokeOwner(owner)); return; }
        send(200, request.url === '/api/location/control' ? locations.control(input, owner) : locations.update(input, owner)); return;
      }
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
      if (request.url === '/api/utterances' && request.method === 'POST') { send(200, await bridge.submit(await body(request, PHOTO_REQUEST_BYTES))); return; }
      if (notifications && request.url === '/api/notifications' && request.method === 'POST') { send(200, await notifications.submit(await body(request))); return; }
      if (request.url === '/mcp' && request.method === 'POST') {
        const result = await rpc(bridge, await body(request), notifications, locations); send(result === undefined ? 202 : 200, result); return;
      }
      if (request.url === '/mcp') { response.setHeader('Allow', 'POST'); send(405, { error: 'Method not allowed' }); return; }
      send(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof PhotoStorageFullError) send(422, { code: 'PHOTO_STORAGE_FULL' });
      else send(400, { error: 'Request rejected; no successful delivery is implied' });
    }
  });
  server.once('close', () => { bridge.close(); unsubscribeBridge(); unsubscribeNotifications?.(); unsubscribeLocations?.(); locations?.close(); for (const wake of [...waiting]) wake(); });
  return server;
}
