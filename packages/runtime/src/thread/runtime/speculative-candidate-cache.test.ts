import { describe, expect, it, vi } from "vitest";
import { createCompactionThreadIdentity } from "./compaction-thread-identity";
import {
  SPECULATIVE_CANDIDATE_CACHE_MAX,
  SpeculativeCandidateCache,
} from "./speculative-candidate-cache";

interface Candidate {
  readonly value: string;
}

const owner = Object.freeze({});
const identity = (key: string) => createCompactionThreadIdentity(owner, key);
const install = (
  cache: SpeculativeCandidateCache<Candidate>,
  key: string,
  value: string
): void => {
  const reservation = cache.reserve(identity(key));
  expect(cache.install(reservation, { value })).toBe(true);
  cache.release(reservation);
};

describe("SpeculativeCandidateCache", () => {
  it("evicts the least recently used candidate while retaining a touched entry", () => {
    // Given: a full candidate cache whose first entry is touched.
    const cache = new SpeculativeCandidateCache<Candidate>();
    for (let index = 0; index < SPECULATIVE_CANDIDATE_CACHE_MAX; index += 1) {
      install(cache, String(index), String(index));
    }
    expect(cache.get(identity("0"))?.value).toBe("0");

    // When: one more candidate is installed.
    install(cache, "overflow", "overflow");

    // Then: key 1 is evicted while the touched key remains.
    expect(cache.get(identity("1"))).toBeUndefined();
    expect(cache.get(identity("0"))?.value).toBe("0");
    expect(cache.size).toBe(SPECULATIVE_CANDIDATE_CACHE_MAX);
  });

  it("rejects an in-flight install after eviction and fresh reuse", () => {
    // Given: an old reservation whose slot is subsequently installed and evicted.
    const cache = new SpeculativeCandidateCache<Candidate>();
    const key = identity("0");
    const old = cache.reserve(key);
    const first = cache.reserve(key);
    expect(cache.install(first, { value: "first" })).toBe(true);
    cache.release(first);
    for (let index = 1; index <= SPECULATIVE_CANDIDATE_CACHE_MAX; index += 1) {
      install(cache, String(index), String(index));
    }
    const fresh = cache.reserve(key);
    expect(cache.install(fresh, { value: "fresh" })).toBe(true);
    cache.release(fresh);

    // When: the old in-flight work settles.
    const installed = cache.install(old, { value: "stale" });
    cache.release(old);

    // Then: CAS refuses to overwrite the fresh candidate.
    expect(installed).toBe(false);
    expect(cache.get(key)?.value).toBe("fresh");
    expect(cache.size).toBeLessThanOrEqual(SPECULATIVE_CANDIDATE_CACHE_MAX);
  });

  it("prevents absent-evicted-absent ABA installation", () => {
    // Given: an absent reservation followed by install, eviction, and reuse.
    const cache = new SpeculativeCandidateCache<Candidate>();
    const key = identity("aba");
    const oldAbsent = cache.reserve(key);
    const installed = cache.reserve(key);
    expect(cache.install(installed, { value: "temporary" })).toBe(true);
    cache.release(installed);
    for (let index = 0; index < SPECULATIVE_CANDIDATE_CACHE_MAX; index += 1) {
      install(cache, `fill-${index}`, String(index));
    }
    const current = cache.reserve(key);
    expect(cache.install(current, { value: "current" })).toBe(true);
    cache.release(current);

    // When: the original absent reservation attempts installation.
    const accepted = cache.install(oldAbsent, { value: "stale" });
    cache.release(oldAbsent);

    // Then: versioned CAS rejects the ABA result.
    expect(accepted).toBe(false);
    expect(cache.get(key)?.value).toBe("current");
  });

  it("counts installed candidates and pending reservations in one bound", () => {
    // Given: 31 installed candidates followed by one unresolved reservation.
    const cache = new SpeculativeCandidateCache<Candidate>();
    for (
      let index = 0;
      index < SPECULATIVE_CANDIDATE_CACHE_MAX - 1;
      index += 1
    ) {
      install(cache, String(index), String(index));
    }
    const pending = cache.reserve(identity("pending"));

    // When: one more candidate consumes the 33rd aggregate slot.
    install(cache, "overflow", "overflow");

    // Then: the installed LRU is evicted and the unresolved slot remains counted.
    expect(cache.get(identity("0"))).toBeUndefined();
    expect(cache.size).toBe(SPECULATIVE_CANDIDATE_CACHE_MAX);
    cache.release(pending);
  });

  it("retains a touched unresolved reservation over an older installed slot", () => {
    // Given: the oldest slot is unresolved before 31 candidates are installed.
    const cache = new SpeculativeCandidateCache<Candidate>();
    const evicted = vi.fn();
    const pending = cache.reserve(identity("pending"), evicted);
    for (
      let index = 0;
      index < SPECULATIVE_CANDIDATE_CACHE_MAX - 1;
      index += 1
    ) {
      install(cache, String(index), String(index));
    }
    cache.touch(identity("pending"));

    // When: a 33rd slot is reserved.
    const overflow = cache.reserve(identity("overflow"));

    // Then: the oldest installed slot leaves while the joined job remains.
    expect(cache.get(identity("0"))).toBeUndefined();
    expect(evicted).not.toHaveBeenCalled();
    cache.release(pending);
    cache.release(overflow);
  });

  it("makes reservation release idempotent", () => {
    // Given: a released absent reservation.
    const cache = new SpeculativeCandidateCache<Candidate>();
    const reservation = cache.reserve(identity("release"));
    cache.release(reservation);

    // When/Then: a racing second cleanup is harmless.
    expect(() => cache.release(reservation)).not.toThrow();
  });
});
