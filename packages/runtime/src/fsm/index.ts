/**
 * Minimal typed finite-state-machine helper.
 *
 * States are modeled as a discriminated union on `tag` so that impossible
 * field combinations are unrepresentable, and every transition is validated
 * against an explicit allow-list at runtime. Illegal transitions throw
 * {@link InvalidStateTransitionError} instead of silently corrupting state.
 */

export interface FsmState {
  readonly tag: string;
}

/** Allowed transitions: for every state tag, the set of reachable tags. */
export type FsmTransitionTable<S extends FsmState> = {
  readonly [K in S["tag"]]: readonly S["tag"][];
};

export class InvalidStateTransitionError extends Error {
  readonly from: string;
  readonly machine: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super(
      `[${machine}] invalid state transition: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`
    );
    this.name = "InvalidStateTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export class Fsm<S extends FsmState> {
  readonly #name: string;
  #state: S;
  readonly #transitions: FsmTransitionTable<S>;

  constructor(options: {
    readonly initial: S;
    readonly name: string;
    readonly transitions: FsmTransitionTable<S>;
  }) {
    this.#name = options.name;
    this.#state = options.initial;
    this.#transitions = options.transitions;
  }

  /** Current state. Narrow it by switching on `state.tag`. */
  get state(): S {
    return this.#state;
  }

  /** Whether the machine is currently in one of the given states. */
  in(...tags: readonly S["tag"][]): boolean {
    return tags.includes(this.#state.tag);
  }

  /** Whether transitioning to `tag` is allowed from the current state. */
  can(tag: S["tag"]): boolean {
    return this.#allowedTargets().includes(tag);
  }

  /**
   * Transition to `next`. Throws {@link InvalidStateTransitionError} when the
   * transition is not declared in the transition table.
   */
  to(next: S): S {
    if (!this.can(next.tag)) {
      throw new InvalidStateTransitionError(
        this.#name,
        this.#state.tag,
        next.tag
      );
    }
    this.#state = next;
    return next;
  }

  /**
   * Transition to `next` only when the machine is still in `fromTag` (guards
   * async completions racing a concurrent transition). Returns whether the
   * transition happened.
   */
  toIf(fromTag: S["tag"], next: S): boolean {
    if (this.#state.tag !== fromTag) {
      return false;
    }
    this.to(next);
    return true;
  }

  /** Assert the machine is in `tag` and return the narrowed state. */
  expect<T extends S["tag"]>(tag: T): Extract<S, { tag: T }> {
    if (this.#state.tag !== tag) {
      throw new Error(
        `[${this.#name}] expected state ${JSON.stringify(tag)}, was ${JSON.stringify(this.#state.tag)}`
      );
    }
    return this.#state as Extract<S, { tag: T }>;
  }

  #allowedTargets(): readonly S["tag"][] {
    const table = this.#transitions as Record<string, readonly S["tag"][]>;
    return table[this.#state.tag] ?? [];
  }
}
