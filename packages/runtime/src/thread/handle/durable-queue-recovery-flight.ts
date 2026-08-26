import type { AgentHost } from "../../execution/host/types";
import { type Deferred, deferred } from "../../internal/deferred";
import { recoverDurableThreadInputs } from "../runtime/durable-input-claims";

/** Per-state recovery lease; active tracks shared-flight membership. */
export interface RecoveryLease {
  active: boolean;
  readonly flight: RecoveryFlight;
  readonly settled: Deferred;
}

/** Shared store recovery state; mutation is its documented purpose. */
export interface RecoveryFlight {
  readonly controller: AbortController;
  readonly leases: Set<RecoveryLease>;
  readonly observed: Promise<void>;
  readonly registration?: RecoveryFlightRegistration;
  settled: boolean;
}

interface RecoveryFlightRegistration {
  readonly byThread: Map<string, RecoveryFlight>;
  readonly threadKey: string;
}

const sharedRecoveries = new WeakMap<object, Map<string, RecoveryFlight>>();

export function leaseRecoveryFlight(
  executionHost: AgentHost | undefined,
  threadKey: string
): RecoveryLease {
  const flight = executionHost
    ? sharedFlight(executionHost, threadKey)
    : createFlight(undefined, threadKey);
  const lease: RecoveryLease = {
    active: true,
    flight,
    settled: deferred(),
  };
  flight.leases.add(lease);
  return lease;
}

export function cancelRecoveryLease(
  lease: RecoveryLease,
  reason: unknown
): void {
  if (!lease.active) {
    return;
  }
  releaseLease(lease);
  const { flight } = lease;
  if (!(flight.settled || flight.leases.size > 0)) {
    evictFlight(flight);
    flight.controller.abort(reason);
  }
  lease.settled.reject(reason);
}

function sharedFlight(
  executionHost: AgentHost,
  threadKey: string
): RecoveryFlight {
  let byThread = sharedRecoveries.get(executionHost.store);
  if (!byThread) {
    byThread = new Map();
    sharedRecoveries.set(executionHost.store, byThread);
  }
  const existing = byThread.get(threadKey);
  if (existing) {
    return existing;
  }
  const flight = createFlight(executionHost, threadKey, {
    byThread,
    threadKey,
  });
  byThread.set(threadKey, flight);
  return flight;
}

function createFlight(
  executionHost: AgentHost | undefined,
  threadKey: string,
  registration?: RecoveryFlightRegistration
): RecoveryFlight {
  const controller = new AbortController();
  const observation = deferred();
  const flight: RecoveryFlight = {
    controller,
    leases: new Set(),
    observed: observation.promise,
    registration,
    settled: false,
  };
  Promise.resolve()
    .then(() =>
      recoverDurableThreadInputs({
        executionHost,
        signal: controller.signal,
        threadKey,
      })
    )
    .then(
      () => settleFlight(flight),
      (error: unknown) => failFlight(flight, error)
    )
    .then(
      () => observation.resolve(),
      () => observation.resolve()
    );
  return flight;
}

function settleFlight(flight: RecoveryFlight): void {
  flight.settled = true;
  evictFlight(flight);
  for (const lease of [...flight.leases]) {
    releaseLease(lease);
    lease.settled.resolve();
  }
}

function failFlight(flight: RecoveryFlight, error: unknown): void {
  flight.settled = true;
  evictFlight(flight);
  for (const lease of [...flight.leases]) {
    releaseLease(lease);
    lease.settled.reject(error);
  }
}

function releaseLease(lease: RecoveryLease): void {
  if (!lease.active) {
    return;
  }
  lease.active = false;
  lease.flight.leases.delete(lease);
}

function evictFlight(flight: RecoveryFlight): void {
  const registration = flight.registration;
  if (registration?.byThread.get(registration.threadKey) === flight) {
    registration.byThread.delete(registration.threadKey);
  }
}
