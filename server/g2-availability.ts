import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChangeSignal } from './changes.ts';
import type { DeliveryAvailability } from '../src/g2-availability.ts';

const reply = z.object({
  id: z.string().uuid(), state: z.enum(['available', 'unavailable', 'unknown']),
}).strict();
interface Reading {
  id: string;
  deadline: number;
  result: Promise<DeliveryAvailability>;
  finish: (state: DeliveryAvailability) => void;
}
interface Peer { runtime: string; lastUpdate: number; latestId?: string; reading?: Reading }
export interface DeliveryObservation {
  owner?: string;
  state: () => DeliveryAvailability;
  recheck?: () => Promise<DeliveryObservation>;
}
const unknown: DeliveryObservation = {state: () => 'unknown'};

/** A busy bridge can outlive a fresh reading. Recheck outside the write queue
 * using the same recipient and deadline before committing either destination. */
export async function commitDelivery<T>(observation: DeliveryObservation | undefined,
  serialize: <R>(action: () => Promise<R>) => Promise<R>, commit: (current?: DeliveryObservation) => T): Promise<T> {
  const retry = Symbol();
  for (;;) {
    const current = observation;
    const result = await serialize(async () => current?.recheck && current.state() === 'unknown' ? retry : commit(current));
    if (result !== retry) return result;
    observation = await current!.recheck!();
  }
}

/** Address a single paired runtime through its existing long poll. Only the
 * current request can supply evidence; no device observations survive a restart. */
export class G2DeliveryAvailability {
  readonly changes = new ChangeSignal();
  private readonly presence = new ChangeSignal();
  private closed = false;
  private peers = new Map<string, Peer>();
  private authorized: (owner: string, runtime: string) => boolean;
  private now: () => number;
  private waitMs: number;
  private holdMs: number;
  private retryMs: number;
  constructor(authorized: (owner: string, runtime: string) => boolean, now = () => performance.now(),
    waitMs = 2500, holdMs = 10_000, retryMs = 750) {
    this.authorized = authorized; this.now = now; this.waitMs = waitMs;
    this.holdMs = holdMs; this.retryMs = retryMs;
  }
  private active(owner: string, peer: Peer) {
    // The device long polls for up to 15 seconds. An expired presence can never
    // answer a request. A current presence alone cannot return "available".
    return this.now() - peer.lastUpdate < 25_000 && this.authorized(owner, peer.runtime);
  }
  private prune(): void {
    for (const [owner, peer] of this.peers) {
      if (this.active(owner, peer)) continue;
      peer.reading?.finish('unknown');
      this.peers.delete(owner);
    }
  }
  currentRuntime(owner: string, runtime: string) { return this.authorized(owner, runtime); }
  observe(owner: string, runtime: string): void {
    if (this.closed) return;
    const old = this.peers.get(owner);
    if (old?.runtime === runtime) { old.lastUpdate = this.now(); return; }
    if (!this.authorized(owner, runtime)) return;
    this.prune();
    old?.reading?.finish('unknown');
    this.peers.set(owner, {runtime, lastUpdate: this.now()});
    this.presence.emit();
  }
  challenge(owner: string, runtime: string) {
    const peer = this.peers.get(owner), reading = peer?.reading;
    if (peer?.runtime === runtime && reading && this.now() < reading.deadline && this.active(owner, peer))
      return {id: reading.id};
  }
  respond(owner: string, runtime: string, input: unknown): boolean {
    const parsed = reply.safeParse(input);
    if (!parsed.success) return false;
    const peer = this.peers.get(owner);
    if (!peer || this.challenge(owner, runtime)?.id !== parsed.data.id) return false;
    peer.reading!.finish(parsed.data.state);
    return true;
  }
  private start(peer: Peer, remaining: number): Reading {
    let settle!: (state: DeliveryAvailability) => void;
    const result = new Promise<DeliveryAvailability>(resolve => { settle = resolve; });
    const wait = Math.min(this.waitMs, remaining);
    const timer = setTimeout(() => reading.finish('unknown'), wait);
    const reading: Reading = {id: randomUUID(), deadline: this.now() + wait, result, finish: state => {
      clearTimeout(timer);
      if (peer.reading === reading) delete peer.reading;
      settle(state);
    }};
    peer.reading = reading;
    peer.latestId = reading.id;
    this.changes.emit();
    return reading;
  }
  private observation(owner: string, peer: Peer, reading: Reading, state: DeliveryAvailability, bound: boolean): DeliveryObservation {
    return {owner, state: () => {
      if (this.now() >= reading.deadline || peer.latestId !== reading.id || this.peers.get(owner) !== peer || !this.active(owner, peer)) return 'unknown';
      if (!bound && [...this.peers].some(([other, p]) => other !== owner && this.active(other, p))) return 'unknown';
      return state;
    }};
  }
  private waitForPresence(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
      const timer = setTimeout(finish, ms);
      const unsubscribe = this.presence.subscribe(finish);
    });
  }
  check(requiredOwner?: string): Promise<DeliveryObservation> {
    this.prune();
    // A question already identifies its pairing, even while its phone is offline.
    // An unaddressed announcement may use only the unique peer present at dispatch.
    const owner = requiredOwner ?? (this.peers.size === 1 ? this.peers.keys().next().value : undefined);
    return owner ? this.checkUntil(owner, !!requiredOwner, performance.now() + this.holdMs) : Promise.resolve(unknown);
  }
  private async checkUntil(owner: string, bound: boolean, deadline: number): Promise<DeliveryObservation> {
    if (this.closed || performance.now() >= deadline) return unknown;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<DeliveryAvailability>(resolve => { timer = setTimeout(() => resolve('unknown'), deadline - performance.now()); });
    try {
      while (!this.closed && performance.now() < deadline) {
        this.prune();
        if (!bound && [...this.peers.keys()].some(other => other !== owner)) return unknown;
        const peer = this.peers.get(owner);
        if (peer) {
          const reading = peer.reading ?? this.start(peer, deadline - performance.now());
          const state = await Promise.race([reading.result, expired]);
          const observation = this.observation(owner, peer, reading, state, bound);
          if (performance.now() < deadline && observation.state() !== 'unknown') {
            observation.recheck = () => this.checkUntil(owner, bound, deadline);
            return observation;
          }
          if (this.peers.get(owner) !== peer) continue;
        }
        const remaining = deadline - performance.now();
        if (remaining > 0 && !this.closed)
          await this.waitForPresence(peer ? Math.min(this.retryMs, remaining) : remaining);
      }
      return unknown;
    } finally { clearTimeout(timer!); }
  }
  close(): void {
    this.closed = true;
    for (const peer of this.peers.values()) peer.reading?.finish('unknown');
    this.peers.clear();
    this.presence.emit();
  }
}
