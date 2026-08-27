import type { AgentHost } from "../../execution";
import type { ThreadStore } from "../../thread/store/types";
import { createCloudflareStorageHost } from "../cloudflare";
import {
  type CelldDurableObjectStorage,
  type CelldScheduler,
  createCelldScheduler,
} from "./scheduler";

export interface CelldDurableObjectState {
  readonly storage: CelldDurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export interface CelldHostOptions {
  readonly clock?: () => number;
  readonly maxPayloadBytes?: number;
  readonly prefix?: string;
  readonly state: CelldDurableObjectState;
  readonly threadStore?: ThreadStore;
}

export interface CelldHost extends AgentHost {
  readonly scheduler: CelldScheduler;
}

export function createCelldHost({
  clock,
  maxPayloadBytes,
  prefix,
  state,
  threadStore,
}: CelldHostOptions): CelldHost {
  const scheduler = createCelldScheduler({
    ...(clock === undefined ? {} : { clock }),
    ...(prefix === undefined ? {} : { prefix }),
    storage: state.storage,
  });
  return {
    ...createCloudflareStorageHost({
      ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
      ...(prefix === undefined ? {} : { prefix }),
      scheduler,
      storage: state.storage,
      ...(threadStore === undefined ? {} : { threadStore }),
    }),
    scheduler,
  };
}
