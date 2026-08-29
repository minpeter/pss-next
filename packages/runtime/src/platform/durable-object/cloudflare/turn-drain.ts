import type { AgentEvent, AgentTurn } from "../../../index";

export type AgentTurnDrainStopReason = "deadline" | "event-budget";

export interface CloudflareAgentTurnDrainOptions {
  readonly deadlineMs?: number;
  readonly maxEvents?: number;
  readonly onEvent?: (event: AgentEvent) => Promise<void> | void;
  readonly startedAt?: number;
}

export interface AgentTurnDrainResult {
  readonly droppedEvents: number;
  readonly events: readonly AgentEvent[];
  readonly stoppedReason?: AgentTurnDrainStopReason;
}

export async function drainAgentTurn(
  run: AgentTurn,
  options: CloudflareAgentTurnDrainOptions = {}
): Promise<AgentEvent[]> {
  return [
    ...(
      await drainAgentTurnWithBudget(run, {
        deadlineMs: options.deadlineMs,
        maxEvents: options.maxEvents,
        onEvent: options.onEvent,
        startedAt: options.startedAt,
      })
    ).events,
  ];
}

export async function drainAgentTurnWithBudget(
  run: AgentTurn,
  options: CloudflareAgentTurnDrainOptions = {}
): Promise<AgentTurnDrainResult> {
  const events: AgentEvent[] = [];
  let droppedEvents = 0;
  const deadlineAt =
    options.deadlineMs === undefined
      ? undefined
      : (options.startedAt ?? Date.now()) + options.deadlineMs;
  const iterator = run.events()[Symbol.asyncIterator]();
  let stoppedReason: AgentTurnDrainStopReason | undefined;

  try {
    while (true) {
      const eventBudgetFull =
        options.maxEvents !== undefined && events.length >= options.maxEvents;
      const nextEvent = await readNextEvent(iterator, deadlineAt);
      if (nextEvent.deadlineExpired) {
        stoppedReason = "deadline";
        break;
      }
      if (nextEvent.result.done) {
        break;
      }
      if (deadlineExpired(deadlineAt)) {
        droppedEvents += 1;
        stoppedReason = "deadline";
        break;
      }
      if (eventBudgetFull) {
        droppedEvents += 1;
        stoppedReason = "event-budget";
        break;
      }
      events.push(nextEvent.result.value);
      await options.onEvent?.(nextEvent.result.value);
    }
  } finally {
    if (stoppedReason) {
      stopIterator(iterator);
    }
  }

  return stoppedReason
    ? { droppedEvents, events, stoppedReason }
    : { droppedEvents, events };
}

type NextEventResult =
  | {
      readonly deadlineExpired: false;
      readonly result: IteratorResult<AgentEvent>;
    }
  | { readonly deadlineExpired: true };

async function readNextEvent(
  iterator: AsyncIterator<AgentEvent>,
  deadlineAt: number | undefined
): Promise<NextEventResult> {
  if (deadlineExpired(deadlineAt)) {
    return { deadlineExpired: true };
  }
  if (deadlineAt === undefined) {
    return { deadlineExpired: false, result: await iterator.next() };
  }

  const remainingMs = Math.max(0, deadlineAt - Date.now());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const nextEvent = iterator.next().then(
    (result) =>
      ({
        deadlineExpired: false,
        result,
      }) satisfies NextEventResult
  );
  const deadline = new Promise<NextEventResult>((resolve) => {
    timeout = setTimeout(() => resolve({ deadlineExpired: true }), remainingMs);
  });

  try {
    return await Promise.race([nextEvent, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function deadlineExpired(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

function stopIterator(iterator: AsyncIterator<AgentEvent>): void {
  const returned = iterator.return?.();
  if (returned) {
    returned.catch(() => undefined);
  }
}
