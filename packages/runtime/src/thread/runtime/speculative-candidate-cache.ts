import { compactionThreadIdentityParts } from "./compaction-thread-identity";

export const SPECULATIVE_CANDIDATE_CACHE_MAX = 32;

interface CandidateSlot<Value extends object> {
  candidate?: Value;
  readonly owner: Readonly<object>;
  readonly reservations: Set<CandidateReservation<Value>>;
  readonly threadKey: string;
  version: Readonly<object>;
}

export interface CandidateReservation<Value extends object> {
  readonly expectedCandidate: Value | undefined;
  readonly onEvict: (() => void) | undefined;
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
    return this.#entryCount();
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

  touch(identity: Readonly<object>): void {
    const { owner, threadKey } = compactionThreadIdentityParts(identity);
    const slot = this.#owners.get(owner)?.get(threadKey);
    if (slot !== undefined) {
      this.#touch(slot);
    }
  }

  reserve(
    identity: Readonly<object>,
    onEvict?: () => void
  ): CandidateReservation<Value> {
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
        reservations: new Set(),
        threadKey,
        version: Object.freeze({}),
      };
      ownerSlots.set(threadKey, slot);
    }
    const reservation = {
      expectedCandidate: slot.candidate,
      onEvict,
      owner,
      released: false,
      slot,
      threadKey,
      version: slot.version,
    };
    slot.reservations.add(reservation);
    this.#touch(slot);
    this.#evict(slot, reservation);
    return reservation;
  }

  install(reservation: CandidateReservation<Value>, next: Value): boolean {
    const ownerSlots = this.#owners.get(reservation.owner);
    const slot = reservation.slot;
    if (
      reservation.released ||
      !slot.reservations.has(reservation) ||
      ownerSlots?.get(reservation.threadKey) !== slot ||
      slot.version !== reservation.version ||
      slot.candidate !== reservation.expectedCandidate
    ) {
      return false;
    }
    slot.reservations.delete(reservation);
    slot.candidate = next;
    slot.version = Object.freeze({});
    this.#touch(slot);
    return true;
  }

  release(reservation: CandidateReservation<Value>): void {
    if (reservation.released) {
      return;
    }
    reservation.released = true;
    const slot = reservation.slot;
    slot.reservations.delete(reservation);
    if (slot.candidate === undefined && slot.reservations.size === 0) {
      this.#removeSlot(slot);
    }
  }

  #entryCount(): number {
    let count = 0;
    for (const slot of this.#lru.keys()) {
      count += slot.reservations.size;
      if (slot.candidate !== undefined) {
        count += 1;
      }
    }
    return count;
  }

  #evict(
    protectedSlot: CandidateSlot<Value>,
    protectedReservation: CandidateReservation<Value>
  ): void {
    while (this.#entryCount() > SPECULATIVE_CANDIDATE_CACHE_MAX) {
      let oldest: CandidateSlot<Value> | undefined;
      for (const slot of this.#lru.keys()) {
        if (slot !== protectedSlot) {
          oldest = slot;
          break;
        }
      }
      if (oldest !== undefined) {
        this.#evictSlot(oldest);
        continue;
      }
      let oldestReservation: CandidateReservation<Value> | undefined;
      for (const reservation of protectedSlot.reservations) {
        if (reservation !== protectedReservation) {
          oldestReservation = reservation;
          break;
        }
      }
      if (oldestReservation === undefined) {
        return;
      }
      this.#evictReservation(oldestReservation);
    }
  }

  #evictReservation(reservation: CandidateReservation<Value>): void {
    reservation.slot.reservations.delete(reservation);
    reservation.onEvict?.();
  }

  #evictSlot(slot: CandidateSlot<Value>): void {
    const reservations = [...slot.reservations];
    slot.candidate = undefined;
    slot.version = Object.freeze({});
    slot.reservations.clear();
    this.#removeSlot(slot);
    for (const reservation of reservations) {
      reservation.onEvict?.();
    }
  }

  #removeSlot(slot: CandidateSlot<Value>): void {
    const ownerSlots = this.#owners.get(slot.owner);
    if (ownerSlots?.get(slot.threadKey) !== slot) {
      return;
    }
    this.#lru.delete(slot);
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
