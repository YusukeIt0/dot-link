import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ChangeSignal } from './changes.ts';
import { callbackUrl, signingSecret, type WebhookSender } from './webhook.ts';
import { distanceMeters, freshLocation, LOCATION_LEASE_MS, LOCATION_FRESH_MS, type LocationFix } from '../src/location-fix.ts';

const SESSION = 'personal-g2';
const EVENT = 'location.updated';
const eventArgs = z.object({ session_id: z.literal(SESSION) }).strict();
const delivery = z.object({ mode: z.literal('webhook'), url: z.string().max(2048), secret: z.string().max(100) }).strict();
const subscriptionSchema = z.object({ id: z.string(), url: z.string(), secret: z.string(), expiresAt: z.number() });
const diskSchema = z.object({ version: z.literal(1), subscription: subscriptionSchema.optional(), revoked: z.array(z.string().uuid()).max(100) });
const fixSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(200), measured_at: z.string().datetime(),
  speed: z.number().min(0).max(400).optional(), heading: z.number().min(0).lt(360).optional(),
}).strict();
type Subscription = z.infer<typeof subscriptionSchema>;
interface FixRecord { id: string; fix: LocationFix; receivedAt: number; }
interface Pending { id: string; anchor: LocationFix; createdAt: number; status: 'sending' | 'accepted' | 'failed'; attempts: number; }

export const locationEvent = {
  name: EVENT,
  description: 'The owner has enabled phone location sharing and their fresh location has changed meaningfully. Coordinates are context, not a request to speak on every update. Read get_location_context, use the owner’s existing preferences and instructions to decide whether nearby information is useful, and remain silent when it is not. No continuous camera view or visit is implied.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { session_id: { type: 'string', const: SESSION } }, required: ['session_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: { session_id: { type: 'string', const: SESSION }, update_id: { type: 'string' } }, required: ['session_id', 'update_id'], additionalProperties: false },
};
export const locationContextTool = {
  name: 'get_location_context',
  description: 'Read the owner’s currently shared phone location and its measured accuracy/time. Returns no coordinates when sharing is off, disconnected or stale. Use existing conversation preferences and requests, not invented interests. Verify current nearby-place information with available search tools before recommending; if no reliable search is available, do not invent places or opening hours. Re-read before deciding if the owner may have moved. Do not infer sight, gaze, a visit or entry into a venue. Location sharing alone does not require a message. Finish using respond_to_location with the context_id, choosing silent or a concise useful announcement.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const locationResponseTool = {
  name: 'respond_to_location',
  description: 'Act on a fresh context_id returned by get_location_context. Choose silent when nothing useful merits interrupting the owner, or announce a concise, verified and personally relevant message to G2. Check recent announcements to avoid repetition. This checks sharing is still enabled and the owner has not moved too far; on rejection, re-read context and reconsider. Use this for location-based announcements instead of send_message_to_g2, so stale or stopped sharing is respected. Identical retries are idempotent. No reply goes to a venue. Stored is not proof of physical display.',
  inputSchema: { type: 'object', properties: { context_id: { type: 'string', format: 'uuid' }, disposition: { type: 'string', enum: ['silent', 'announce'] }, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['context_id', 'disposition'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** Persist the subscription, but never a trail of coordinates. Restart needs fresh phone data. */
export class LocationContext {
  readonly changes = new ChangeSignal();
  private disk: z.infer<typeof diskSchema>;
  private sharingId?: string;
  private owner?: string;
  private leaseUntil = 0;
  private sequence = -1;
  private latest?: FixRecord;
  private reads = new Map<string, FixRecord>();
  private outcomes = new Map<string, { disposition: 'silent' | 'announce'; text?: string; result: unknown }>();
  private pending?: Pending;
  private lastAnchor?: LocationFix;
  private lastEventAt = -Infinity;
  private retry?: ReturnType<typeof setTimeout>;
  private lastReadAt?: string;
  private lastDecisionAt?: string;
  private lastAnnouncementAt?: string;
  private announceTail: Promise<unknown> = Promise.resolve();
  private subscriptions: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private received = 0;
  private delivered = 0;
  private sent = 0;
  private path: string;
  private sender: WebhookSender;
  private hosts: string[];
  private announce: (input: { message_id: string; text: string }, stillAllowed: () => boolean, location: {sharing_id: string; expires_at: string}) => Promise<unknown>;
  private now: () => number;
  constructor(path: string, sender: WebhookSender, hosts: string[],
    announce: (input: { message_id: string; text: string }, stillAllowed: () => boolean, location: {sharing_id: string; expires_at: string}) => Promise<unknown>, now = Date.now) {
    this.path = path; this.sender = sender; this.hosts = hosts; this.announce = announce; this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { this.disk = diskSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Location subscription could not be loaded');
      this.disk = { version: 1, revoked: [] }; this.save();
    }
  }
  private save() { writeFileSync(`${this.path}.tmp`, JSON.stringify(this.disk), { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path); }
  private active(): Subscription | undefined { const sub = this.disk.subscription; return sub && sub.expiresAt > this.now() ? sub : undefined; }
  private usable() { return !!this.sharingId && this.leaseUntil > this.now() && freshLocation(this.latest?.fix, this.now()); }
  status() {
    return { locationSubscribed: !!this.active(), locationSharing: !!this.sharingId && this.leaseUntil > this.now(),
      locationFresh: this.usable(), locationReceivedAt: this.latest ? new Date(this.latest.receivedAt).toISOString() : null,
      locationMeasuredAt: this.latest?.fix.measured_at ?? null, locationAccuracy: this.latest?.fix.accuracy ?? null,
      locationDotReadAt: this.lastReadAt ?? null, locationDecisionAt: this.lastDecisionAt ?? null,
      locationAnnouncementAt: this.lastAnnouncementAt ?? null, locationDelivery: this.pending?.status ?? null,
      locationReceivedCount: this.received, locationEventCount: this.delivered, locationAnnouncementCount: this.sent };
  }
  control(raw: unknown, owner: string) {
    const p = z.object({ sharing_id: z.string().uuid(), enabled: z.boolean() }).strict().parse(raw);
    if (!p.enabled) {
      if (this.sharingId === p.sharing_id && this.owner !== owner) throw new Error('Sharing belongs to another device');
      // Revocation wins over a delayed enable/update using this same session.
      if (!this.disk.revoked.includes(p.sharing_id)) { this.disk.revoked.push(p.sharing_id); this.disk.revoked = this.disk.revoked.slice(-100); this.save(); }
      if (this.sharingId === p.sharing_id && this.owner === owner) this.clear();
      return { enabled: false };
    }
    if (this.disk.revoked.includes(p.sharing_id)) throw new Error('Sharing session revoked');
    if (this.sharingId && this.owner !== owner && this.leaseUntil > this.now()) throw new Error('Another device is sharing');
    if (this.sharingId !== p.sharing_id || this.owner !== owner) {
      if (this.sharingId && !this.disk.revoked.includes(this.sharingId)) { this.disk.revoked.push(this.sharingId); this.disk.revoked = this.disk.revoked.slice(-100); this.save(); }
      this.clear(); this.sharingId = p.sharing_id; this.owner = owner;
    }
    this.leaseUntil = this.now() + LOCATION_LEASE_MS; this.changes.emit();
    return { enabled: true, lease_ms: LOCATION_LEASE_MS };
  }
  revokeOwner(owner: string) {
    if (this.sharingId && this.owner === owner) return this.control({sharing_id: this.sharingId, enabled: false}, owner);
    return {enabled: false};
  }
  update(raw: unknown, owner: string) {
    const p = z.object({ sharing_id: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), fix: fixSchema.optional() }).strict().parse(raw);
    if (this.disk.revoked.includes(p.sharing_id) || p.sharing_id !== this.sharingId || owner !== this.owner) throw new Error('Sharing not enabled');
    if (p.sequence <= this.sequence) return { accepted: false, ...this.status() };
    if (p.fix && !freshLocation(p.fix, this.now())) throw new Error('Location is stale');
    this.sequence = p.sequence; this.leaseUntil = this.now() + LOCATION_LEASE_MS;
    if (p.fix && (!this.latest || Date.parse(p.fix.measured_at) >= Date.parse(this.latest.fix.measured_at))) {
      this.latest = { id: randomUUID(), fix: p.fix, receivedAt: this.now() }; this.received++;
    }
    this.maybeEvent(); this.changes.emit();
    return { accepted: true, ...this.status() };
  }
  read(raw: unknown = {}) {
    z.object({}).strict().parse(raw);
    const status = this.status();
    if (!this.usable() || !this.latest) return { ...status, context: null, recent_announcements: [] as (string | undefined)[] };
    const current = this.latest;
    this.reads.set(current.id, current);
    while (this.reads.size > 20) this.reads.delete(this.reads.keys().next().value!);
    this.lastReadAt = new Date(this.now()).toISOString(); this.changes.emit();
    return { ...status, context: { context_id: current.id, ...current.fix, received_at: new Date(current.receivedAt).toISOString(),
      source: 'phone_location', update_id: this.pending?.id ?? null },
      recent_announcements: [...this.outcomes.values()].filter(o => o.disposition === 'announce').slice(-5).map(o => o.text) };
  }
  respond(raw: unknown) {
    const p = z.object({ context_id: z.string().uuid(), disposition: z.enum(['silent', 'announce']), text: z.string().trim().min(1).max(2000).optional() }).strict().parse(raw);
    if ((p.disposition === 'announce') !== (p.text !== undefined)) throw new Error('Announcement requires text; silent does not');
    const operation = this.announceTail.then(async () => {
      const previous = this.outcomes.get(p.context_id);
      if (previous) {
        if (previous.disposition !== p.disposition || previous.text !== p.text) throw new Error('Conflicting location decision');
        return previous.result;
      }
      const read = this.reads.get(p.context_id);
      if (!read || !this.usable() || !freshLocation(read.fix, this.now()) || !this.latest || distanceMeters(read.fix, this.latest.fix) > 100) throw new Error('Location changed or sharing stopped; read context again');
      const generation = this.generation;
      const stillAllowed = () => generation === this.generation && this.usable() && freshLocation(read.fix, this.now()) && !!this.latest && distanceMeters(read.fix, this.latest.fix) <= 100;
      const result = p.disposition === 'announce' ? await this.announce({ message_id: p.context_id, text: p.text! }, stillAllowed,
        {sharing_id: this.sharingId!, expires_at: new Date(Date.parse(read.fix.measured_at) + LOCATION_FRESH_MS).toISOString()}) : { stored_for_g2: false };
      if (generation !== this.generation) return result;
      this.outcomes.set(p.context_id, { disposition: p.disposition, text: p.text, result });
      while (this.outcomes.size > 30) this.outcomes.delete(this.outcomes.keys().next().value!);
      this.lastDecisionAt = new Date(this.now()).toISOString();
      if (p.disposition === 'announce') { this.lastAnnouncementAt = this.lastDecisionAt; this.sent++; }
      this.lastAnchor = read.fix; this.pending = undefined;
      if (this.retry) clearTimeout(this.retry);
      this.changes.emit();
      // New movement during reasoning can be considered on the next phone update.
      return result;
    });
    this.announceTail = operation.catch(() => {}); return operation;
  }
  private clear() {
    this.generation++; this.sharingId = undefined; this.owner = undefined; this.leaseUntil = 0; this.sequence = -1;
    this.latest = undefined; this.reads.clear(); this.outcomes.clear(); this.pending = undefined; this.lastAnchor = undefined; this.lastEventAt = -Infinity;
    if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    this.changes.emit();
  }
  private maybeEvent() {
    if (!this.usable() || !this.active() || !this.latest) return;
    if (this.pending && this.now() - this.pending.createdAt < 120_000) return;
    const fix = this.latest.fix;
    const moved = !this.lastAnchor || distanceMeters(fix, this.lastAnchor) >= Math.max(50, fix.accuracy + this.lastAnchor.accuracy);
    if (!moved || this.now() - this.lastEventAt < 30_000) return;
    this.lastEventAt = this.now();
    this.pending = { id: randomUUID(), anchor: fix, createdAt: this.now(), status: 'sending', attempts: 0 };
    void this.deliver(this.pending, this.generation);
  }
  private async deliver(pending: Pending, generation: number) {
    const sub = this.active();
    if (!sub || generation !== this.generation || this.pending !== pending || !this.usable()) return;
    pending.attempts++;
    let status = 0;
    try {
      status = (await this.sender.send(sub, `evt_location_${pending.id}`, {
        eventId: `evt_location_${pending.id}`, name: EVENT, timestamp: new Date(pending.createdAt).toISOString(),
        data: { session_id: SESSION, update_id: pending.id }, cursor: null,
      })).status;
    } catch { /* No coordinates, callback URLs or secrets in logs. */ }
    if (generation !== this.generation || this.pending !== pending) return;
    pending.status = status >= 200 && status < 300 ? 'accepted' : 'failed';
    if (pending.status === 'accepted') { this.delivered++; this.lastAnchor = pending.anchor; }
    if (status === 410 && this.disk.subscription?.id === sub.id) { delete this.disk.subscription; this.save(); }
    if ((status === 0 || status === 429 || status >= 500) && pending.attempts < 3) {
      this.retry = setTimeout(() => { void this.deliver(pending, generation); }, 2000 * 2 ** (pending.attempts - 1)); this.retry.unref();
    }
    this.changes.emit();
  }
  subscribe(raw: unknown) {
    const run = this.subscriptions.then(async () => {
      const p = z.object({ name: z.literal(EVENT), arguments: eventArgs, delivery, cursor: z.null().optional(), ttlMs: z.number().int().positive().max(86_400_000).nullable().optional() }).parse(raw);
      callbackUrl(p.delivery.url, this.hosts); signingSecret(p.delivery.secret);
      const id = 'sub_' + createHash('sha256').update(JSON.stringify([SESSION, EVENT, p.delivery.url])).digest('hex').slice(0, 32);
      if (this.active() && this.active()!.id !== id) throw new Error('Location subscriber already exists');
      const sub = { id, url: p.delivery.url, secret: p.delivery.secret, expiresAt: this.now() + (p.ttlMs ?? 3_600_000) };
      await this.sender.verify(sub); this.disk.subscription = sub; this.save(); this.maybeEvent(); this.changes.emit();
      return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
    });
    this.subscriptions = run.catch(() => {}); return run;
  }
  unsubscribe(raw: unknown) {
    const run = this.subscriptions.then(() => {
      const p = z.object({ name: z.literal(EVENT), arguments: eventArgs, delivery: delivery.omit({ secret: true }) }).parse(raw);
      if (this.disk.subscription?.url === p.delivery.url) { delete this.disk.subscription; this.save(); this.pending = undefined; if (this.retry) clearTimeout(this.retry); this.changes.emit(); }
      return {};
    });
    this.subscriptions = run.catch(() => {}); return run;
  }
  close() { if (this.retry) clearTimeout(this.retry); }
}
