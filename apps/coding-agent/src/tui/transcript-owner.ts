import { type Component, Container, Spacer } from "@earendil-works/pi-tui";
import {
  type ColdContent,
  captureComponent,
  hasGraphics,
  renderColdContent,
} from "./cold-content";
import { SnapshotText as Text } from "./snapshot-views";

/** Immutable content with width-dependent, synchronous, renderer-free layout. */
export class ColdSnapshot implements Component {
  readonly #content: ColdContent;

  constructor(content: ColdContent | readonly string[], _width?: number) {
    // Reject callbacks and detach every nested array/object supplied by a view.
    this.#content = structuredClone(
      Array.isArray(content)
        ? {
            kind: "fixed",
            rows: content,
            reason: hasGraphics(content) ? "graphics" : "opaque-renderer",
          }
        : content
    ) as ColdContent;
  }

  static capture(component: Component, width: number): ColdSnapshot {
    const rows = [...component.render(width)];
    return new ColdSnapshot({
      kind: "selected",
      width,
      rows,
      content: captureComponent(component, width),
    });
  }

  captureCold(): ColdContent {
    return structuredClone(this.#content);
  }

  invalidate(): void {
    /* No live renderer or source survives handoff. */
  }

  render(width: number): string[] {
    return renderColdContent(this.#content, Math.max(1, width));
  }
}

export interface TranscriptLease<T extends Component = Component> {
  readonly active: boolean;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly view: T;
}

interface HotBlock {
  controller: AbortController;
  dispose?: () => void;
  lease: TranscriptLease;
  mounted: Component;
  settle?: () => void;
}

/** The single output owner, shared by dispatch, commands, replay and input. */
export class TranscriptOwner extends Container {
  #epoch = 0;
  #epochController = new AbortController();
  #sealing = false;
  #hot: HotBlock | undefined;
  #reservationWidth: number | undefined;
  #height = 0;
  readonly #width: () => number;

  constructor(width: () => number) {
    super();
    this.#width = width;
  }
  get epoch(): number {
    return this.#epoch;
  }
  get signal(): AbortSignal {
    return this.#epochController.signal;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    this.#height =
      width === this.#reservationWidth
        ? Math.max(this.#height, lines.length)
        : lines.length;
    this.#reservationWidth = width;
    // Only the owner synthesizes padding, after ALL actual content. Appends
    // (including separators) consume this tail without changing COLD rows.
    return [
      ...lines,
      ...Array.from({ length: this.#height - lines.length }, () => ""),
    ];
  }

  /** One-shot appends are immediately COLD. No caller can bypass handoff. */
  override addChild(component: Component): void {
    this.finish();
    super.addChild(ColdSnapshot.capture(component, this.#width()));
  }

  acquire<T extends Component>(
    create: (
      permission: Pick<TranscriptLease, "active" | "signal" | "epoch">
    ) => T,
    options: {
      dispose?: (view: T) => void;
      label?: string;
      leadingSpacer?: boolean;
      settle?: (view: T) => void;
    } = {}
  ): TranscriptLease<T> {
    this.finish();
    const controller = new AbortController();
    const epoch = this.#epoch;
    const owner = this;
    const permission = {
      epoch,
      signal: controller.signal,
      get active() {
        return (
          !(owner.#sealing || controller.signal.aborted) &&
          owner.epoch === epoch
        );
      },
    };
    const view = create(permission);
    const lease = {
      ...permission,
      get active() {
        return permission.active;
      },
      view,
    };
    let mounted: Component = view;
    if (options.label) {
      const block = new Container();
      block.addChild(new Text(options.label, 1, 0));
      block.addChild(view);
      mounted = block;
    }
    if (options.leadingSpacer ?? true) {
      super.addChild(ColdSnapshot.capture(new Spacer(1), this.#width()));
    }
    super.addChild(mounted);
    this.#hot = {
      controller,
      lease,
      mounted,
      settle: () => options.settle?.(view),
      dispose: () => options.dispose?.(view),
    };
    return lease;
  }

  /** A stream may finish only its own lease, never another command's tail. */
  finish(lease?: TranscriptLease): void {
    const hot = this.#hot;
    if (!hot || (lease && hot.lease !== lease)) {
      return;
    }
    hot.settle?.();
    this.#sealing = true;
    try {
      const width = this.#width();
      if (width !== this.#reservationWidth) {
        this.#height = 0;
        this.#reservationWidth = width;
      }
      // Snapshot actual rows, never the owner's synthetic trailing reserve.
      const snapshot = ColdSnapshot.capture(hot.mounted, width);
      this.#hot = undefined;
      this.children[this.children.indexOf(hot.mounted)] = snapshot;
      // Revoke before callbacks from abort/dispose can request renders or notify.
      hot.controller.abort();
      hot.dispose?.();
    } finally {
      this.#sealing = false;
    }
  }

  reset(_reason: "initial-replay" | "session-navigation"): void {
    this.finish();
    this.#epoch += 1;
    this.#epochController.abort();
    this.#epochController = new AbortController();
    super.clear();
    this.#height = 0;
    this.#reservationWidth = undefined;
  }
}
