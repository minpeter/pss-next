import { compactionThreadIdentityParts } from "./compaction-thread-identity";

export const SPECULATIVE_CANDIDATE_CACHE_MAX = 32;

interface CandidateSlot<Value extends object> {
  candidate?: Value;
  readonly owner: Readonly<object>;
  reservations: number;
  readonly threadKey: string;
  version: Readonly<object>;
}

export interface CandidateReservation<Value extends object> {
  readonly expectedCandidate: Value | undefined;
  readonly owner: Readonly<object>;
  released: boolean;
  readonly slot: CandidateSlot<Value>;
  readonly threadKey: string;
  readonly version: Readonly<object>;
}

export class SpeculativeCandidateCache<Value extends object> {
  readonly #owners = new WeakMap<
    Readonly<object>,
    Map<string, CandidateSlot<Value>>
  >();
  readonly #lru = new Map<CandidateSlot<Value>, true>();

  get size(): number {
    return this.#lru.size;
  }

  get(identity: Readonly<object>): Value | undefined {
    const { owner, threadKey } = compactionThreadIdentityParts(identity);
    const slot = this.#owners.get(owner)?.get(threadKey);
    if (slot?.candidate === undefined) {
      return;
    }
    this.#touch(slot);
    return slot.candidate;
  }

  reserve(identity: Readonly<object>): CandidateReservation<Value> {
    const { owner, threadKey } = compactionThreadIdentityParts(identity);
    let ownerSlots = this.#owners.get(owner);
    if (ownerSlots === undefined) {
      ownerSlots = new Map();
      this.#owners.set(owner, ownerSlots);
    }
    let slot = ownerSlots.get(threadKey);
    if (slot === undefined) {
      slot = {
        owner,
        reservations: 0,
        threadKey,
        version: Object.freeze({}),
      };
      ownerSlots.set(threadKey, slot);
    }
    slot.reservations += 1;
    return {
      expectedCandidate: slot.candidate,
      owner,
      released: false,
      slot,
      threadKey,
      version: slot.version,
    };
  }

  install(reservation: CandidateReservation<Value>, next: Value): boolean {
    const ownerSlots = this.#owners.get(reservation.owner);
    const slot = reservation.slot;
    if (
      ownerSlots?.get(reservation.threadKey) !== slot ||
      slot.version !== reservation.version ||
      slot.candidate !== reservation.expectedCandidate
    ) {
      return false;
    }
    slot.candidate = next;
    slot.version = Object.freeze({});
    this.#touch(slot);
    this.#evict();
    return true;
  }

  release(reservation: CandidateReservation<Value>): void {
    if (reservation.released) {
      throw new TypeError(
        "Speculative candidate reservation was already released."
      );
    }
    reservation.released = true;
    const slot = reservation.slot;
    slot.reservations -= 1;
    if (slot.candidate === undefined && slot.reservations === 0) {
      this.#removeSlot(slot);
    }
  }

  #evict(): void {
    while (this.#lru.size > SPECULATIVE_CANDIDATE_CACHE_MAX) {
      const oldest = this.#lru.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#lru.delete(oldest);
      oldest.candidate = undefined;
      oldest.version = Object.freeze({});
      if (oldest.reservations === 0) {
        this.#removeSlot(oldest);
      }
    }
  }

  #removeSlot(slot: CandidateSlot<Value>): void {
    const ownerSlots = this.#owners.get(slot.owner);
    if (ownerSlots?.get(slot.threadKey) !== slot) {
      return;
    }
    ownerSlots.delete(slot.threadKey);
    if (ownerSlots.size === 0) {
      this.#owners.delete(slot.owner);
    }
  }

  #touch(slot: CandidateSlot<Value>): void {
    this.#lru.delete(slot);
    this.#lru.set(slot, true);
  }
}
