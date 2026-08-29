import type { AgentHost } from "../../../execution";
import type { ThreadStore } from "../../../thread/store/types";
import { createDurableObjectStorageHost } from "../host/storage-host";
import {
  drainCelldScheduledWork as drainScheduledWork,
  type CelldScheduledWorkAgent as ScheduledWorkAgent,
  type CelldScheduledWorkDrainOptions as ScheduledWorkDrainOptions,
  type CelldScheduledWorkDrainResult as ScheduledWorkDrainResult,
  type CelldScheduledWorkRunContext as ScheduledWorkRunContext,
} from "./drainer";
import {
  createCelldScheduler as createScheduler,
  listCelldScheduledRuns as listScheduledRuns,
  listCelldScheduledThreadPrompts as listScheduledThreadPrompts,
} from "./scheduler";
import {
  ackCelldScheduledRun as ackScheduledRun,
  ackCelldScheduledThreadPrompt as ackScheduledThreadPrompt,
  claimCelldScheduledRun as claimScheduledRun,
  claimCelldScheduledThreadPrompt as claimScheduledThreadPrompt,
  rearmCelldScheduledWork as rearmScheduledWork,
  retryCelldScheduledRun as retryScheduledRun,
  retryCelldScheduledThreadPrompt as retryScheduledThreadPrompt,
} from "./scheduler-claims";
import type {
  CelldDurableObjectStorage as CelldDurableObjectStorageType,
  CelldScheduler,
  CelldScheduledWorkListOptions as ScheduledWorkListOptions,
  CelldSchedulerOptions as SchedulerOptions,
} from "./scheduler-support";

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

export type CelldScheduledWorkAgent = ScheduledWorkAgent;
export type CelldScheduledWorkDrainOptions = ScheduledWorkDrainOptions;
export type CelldScheduledWorkDrainResult = ScheduledWorkDrainResult;
export type CelldScheduledWorkRunContext = ScheduledWorkRunContext;
export const drainCelldScheduledWork = drainScheduledWork;
export const createCelldScheduler = createScheduler;
export const listCelldScheduledRuns = listScheduledRuns;
export const listCelldScheduledThreadPrompts = listScheduledThreadPrompts;
export const ackCelldScheduledRun = ackScheduledRun;
export const ackCelldScheduledThreadPrompt = ackScheduledThreadPrompt;
export const claimCelldScheduledRun = claimScheduledRun;
export const claimCelldScheduledThreadPrompt = claimScheduledThreadPrompt;
export const rearmCelldScheduledWork = rearmScheduledWork;
export const retryCelldScheduledRun = retryScheduledRun;
export const retryCelldScheduledThreadPrompt = retryScheduledThreadPrompt;
export type CelldScheduledWorkListOptions = ScheduledWorkListOptions;
export type CelldSchedulerOptions = SchedulerOptions;
export type CelldDurableObjectStorage = CelldDurableObjectStorageType;

export function createCelldHost({
  clock,
  maxPayloadBytes,
  prefix,
  state,
  threadStore,
}: CelldHostOptions): CelldHost {
  const scheduler = createScheduler({
    ...(clock === undefined ? {} : { clock }),
    ...(prefix === undefined ? {} : { prefix }),
    storage: state.storage,
  });
  state.waitUntil(
    rearmScheduledWork(state.storage, {
      ...(clock === undefined ? {} : { nowMs: clock() }),
      ...(prefix === undefined ? {} : { prefix }),
    })
  );
  return {
    ...createDurableObjectStorageHost({
      ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
      ...(prefix === undefined ? {} : { prefix }),
      scheduler,
      storage: state.storage,
      ...(threadStore === undefined ? {} : { threadStore }),
    }),
    scheduler,
  };
}
