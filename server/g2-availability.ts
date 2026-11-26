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
export interface DeliveryObservation { owner?: string; state: () => DeliveryAvailability }
const unknown: DeliveryObservation = {state: () => 'unknown'};

/** Address a single paired runtime through its existing long poll. Only the
 * current request can supply evidence; no device observations survive a restart. */
export class G2DeliveryAvailability {
  readonly changes = new ChangeSignal();
  private peers = new Map<string, Peer>();
  private authorized: (owner: string, runtime: string) => boolean;
  private now: () => number;
  private waitMs: number;
  constructor(authorized: (owner: string, runtime: string) => boolean, now = () => performance.now(), waitMs = 2500) {
    this.authorized = authorized; this.now = now; this.waitMs = waitMs;
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
    const old = this.peers.get(owner);
    if (old?.runtime === runtime) { old.lastUpdate = this.now(); return; }
    if (!this.authorized(owner, runtime)) return;
    this.prune();
    old?.reading?.finish('unknown');
    this.peers.set(owner, {runtime, lastUpdate: this.now()});
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
  private start(peer: Peer): Reading {
    let settle!: (state: DeliveryAvailability) => void;
    const result = new Promise<DeliveryAvailability>(resolve => { settle = resolve; });
    const timer = setTimeout(() => reading.finish('unknown'), this.waitMs);
    const reading: Reading = {id: randomUUID(), deadline: this.now() + this.waitMs, result, finish: state => {
      clearTimeout(timer);
      if (peer.reading === reading) delete peer.reading;
      settle(state);
    }};
    peer.reading = reading;
    peer.latestId = reading.id;
    this.changes.emit();
    return reading;
  }
  async check(requiredOwner?: string): Promise<DeliveryObservation> {
    this.prune();
    const owner = requiredOwner ?? (this.peers.size === 1 ? this.peers.keys().next().value : undefined);
    const peer = owner && this.peers.get(owner);
    if (!peer || !owner) return unknown;
    const reading = peer.reading ?? this.start(peer);
    const state = await reading.result;
    return {owner, state: () => {
      if (this.now() >= reading.deadline || peer.latestId !== reading.id || this.peers.get(owner) !== peer || !this.active(owner, peer)) return 'unknown';
      if (!requiredOwner && [...this.peers].some(([other, p]) => other !== owner && this.active(other, p))) return 'unknown';
      return state;
    }};
  }
  close(): void {
    for (const peer of this.peers.values()) peer.reading?.finish('unknown');
    this.peers.clear();
  }
}
