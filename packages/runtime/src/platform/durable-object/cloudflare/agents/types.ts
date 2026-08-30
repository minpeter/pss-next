import type { AgentEvent } from "../../../../thread/protocol/events";
import type { AgentTurn } from "../../../../thread/protocol/turn";
import type { DurableObjectStorage as CloudflareDurableObjectStorage } from "../../storage/durable-object/durable-object-storage";
import type { CloudflareAgentsFiberPayload } from "./payload";

export type CloudflareAgentsFiberStatus =
  | "aborted"
  | "completed"
  | "error"
  | "interrupted"
  | "pending"
  | "running";

export interface CloudflareAgentsFiberContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly snapshot: unknown | null;
  stash(data: unknown): void;
}

export interface CloudflareAgentsFiberRecoveryContext {
  readonly createdAt: number;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown> | null;
  readonly name: string;
  readonly recoveryReason: "interrupted";
  readonly snapshot: unknown | null;
  readonly status?: CloudflareAgentsFiberStatus;
}

export type CloudflareAgentsFiberRecoveryResult =
  | {
      readonly metadata?: Record<string, unknown>;
      readonly snapshot?: unknown;
      readonly status: "completed";
    }
  | {
      readonly error?: unknown;
      readonly snapshot?: unknown;
      readonly status: "error";
    }
  | {
      readonly reason?: string;
      readonly snapshot?: unknown;
      readonly status: "aborted" | "interrupted";
    };

export interface CloudflareAgentsStartFiberOptions {
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
  readonly waitForCompletion?: boolean;
}

export interface CloudflareAgentsFiberInspection {
  readonly createdAt: number;
  readonly error?: string;
  readonly fiberId: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
  readonly settledAt?: number;
  readonly snapshot?: unknown;
  readonly startedAt?: number;
  readonly status: CloudflareAgentsFiberStatus;
}

export interface CloudflareAgentsStartFiberResult
  extends CloudflareAgentsFiberInspection {
  readonly accepted: boolean;
}

export interface CloudflareAgentsScheduleRetryOptions {
  readonly baseDelayMs?: number;
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
}

export interface CloudflareAgentsScheduleOptions {
  readonly idempotent?: boolean;
  readonly retry?: CloudflareAgentsScheduleRetryOptions;
}

interface CloudflareAgentsScheduleBase<TPayload> {
  readonly callback: string;
  readonly id: string;
  readonly payload: TPayload;
  readonly retry?: CloudflareAgentsScheduleRetryOptions;
}

export type CloudflareAgentsSchedule<TPayload> =
  | (CloudflareAgentsScheduleBase<TPayload> & {
      readonly time: number;
      readonly type: "scheduled";
    })
  | (CloudflareAgentsScheduleBase<TPayload> & {
      readonly delayInSeconds: number;
      readonly time: number;
      readonly type: "delayed";
    })
  | (CloudflareAgentsScheduleBase<TPayload> & {
      readonly cron: string;
      readonly time: number;
      readonly type: "cron";
    })
  | (CloudflareAgentsScheduleBase<TPayload> & {
      readonly intervalSeconds: number;
      readonly time: number;
      readonly type: "interval";
    });

export interface CloudflareAgentsDurableObjectContext {
  readonly storage: CloudflareDurableObjectStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export type CloudflareAgentsRunSource = "scheduled-run" | "thread-prompt";

export interface CloudflareAgentsScheduledRunContext {
  readonly kind: "run";
  readonly prefix: string;
  readonly runId: string;
  readonly source: "scheduled-run";
  readonly threadKey?: string;
}

export interface CloudflareAgentsThreadPromptContext {
  readonly idempotencyKey: string | undefined;
  readonly kind: "thread";
  readonly notificationId: string | undefined;
  readonly prefix: string;
  readonly runId: string;
  readonly source: "thread-prompt";
  readonly threadKey: string;
}

export type CloudflareAgentsRunContext =
  | CloudflareAgentsScheduledRunContext
  | CloudflareAgentsThreadPromptContext;

export type CloudflareAgentsEventHandler = (
  context: CloudflareAgentsRunContext,
  event: AgentEvent
) => Promise<void> | void;

export type CloudflareAgentsCallbackName<
  TAgent extends CloudflareAgentsPlatformAgent = CloudflareAgentsPlatformAgent,
> = Extract<keyof TAgent, string> | "resumePssRuntimeFiber";

export interface CloudflareAgentsDefaultResumeAgent
  extends CloudflareAgentsPlatformAgent {
  resumePssRuntimeFiber(payload: unknown): Promise<void>;
}

export interface CloudflareAgentsPlatformAgent {
  schedule<TPayload extends CloudflareAgentsFiberPayload>(
    when: Date | number | string,
    callback: keyof this,
    payload: TPayload,
    options?: CloudflareAgentsScheduleOptions
  ): Promise<CloudflareAgentsSchedule<TPayload>>;
  startFiber(
    name: string,
    fn: (ctx: CloudflareAgentsFiberContext) => Promise<void>,
    options?: CloudflareAgentsStartFiberOptions
  ): Promise<CloudflareAgentsStartFiberResult>;
}

export interface CloudflareAgentsTurnDrainOptions {
  readonly deadlineMs?: number;
  readonly maxEvents?: number;
  readonly onEvent?: CloudflareAgentsEventHandler;
}

export interface CloudflareAgentsResumeOptions {
  readonly claim?: object;
}

export type CloudflareAgentsResumeRun = (
  payload: CloudflareAgentsFiberPayload,
  options?: CloudflareAgentsResumeOptions
) => Promise<AgentTurn | null>;

export type CloudflareAgentsRetryReason =
  | "deadline"
  | "error"
  | "event-budget"
  | "not-claimable";

export type CloudflareAgentsRetryFiber = (
  payload: CloudflareAgentsFiberPayload,
  reason: CloudflareAgentsRetryReason,
  authority?: object
) => Promise<boolean>;
