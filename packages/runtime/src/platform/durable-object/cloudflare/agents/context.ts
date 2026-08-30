import type { AgentHost } from "../../../../execution";
import {
  type CloudflareHostOptions,
  createCloudflareHost,
} from "../host/create-cloudflare-host";
import { recoverCloudflareAgentsFiber } from "./fiber";
import { createCloudflareAgentsFiberRetryScheduler } from "./retry-scheduler";
import { resumeScheduledCloudflareAgentsFiber } from "./scheduled-fiber";
import type {
  CloudflareAgentsPayloadTrustOptions,
  CloudflareAgentsPrefixGuardOptions,
} from "./trust";
import type {
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeOptions,
  CloudflareAgentsResumeRun,
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

const defaultPrefix = "pss-runtime";

type MaybePromise<T> = Promise<T> | T;

export interface CloudflarePlatformFactoryOptions<
  Env,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> {
  readonly cloudflareAgent: TAgent;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
  readonly host: AgentHost;
  readonly prefix: string;
}

interface CloudflarePlatformContextBaseOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends CloudflareAgentsDefaultResumeAgent,
> {
  readonly allowedPrefixes?: readonly string[];
  readonly allowPrefix?: CloudflarePlatformPrefixGuard<Env>;
  readonly cloudflareAgent: TAgent;
  readonly createAgent: (
    options: CloudflarePlatformFactoryOptions<Env, TAgent>
  ) => MaybePromise<CreatedAgent>;
  readonly defaultPrefix?: string;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
  readonly retryMaxAttempts?: number;
  readonly retryMaxRunAfterMs?: number;
  readonly retryRunAfterMs?: number;
}

export type CloudflarePlatformContextOptions<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflarePlatformContextBaseOptions<Env, CreatedAgent, TAgent> &
  Pick<CloudflareHostOptions<TAgent>, "delayedResumeCallback">;

export interface CloudflarePlatformContext<
  CreatedAgent extends CloudflareAgentsResumableAgent,
> {
  agent(prefix?: string): Promise<CreatedAgent>;
  host(prefix?: string): AgentHost;
  recoverFiber(
    ctx: CloudflareAgentsFiberRecoveryContext
  ): Promise<CloudflareAgentsFiberRecoveryResult | false>;
  resumeScheduledFiber(
    payload: unknown
  ): Promise<CloudflareAgentsStartFiberResult>;
}

export interface CloudflareAgentsResumableAgent {
  resume(
    runId: string,
    options?: CloudflareAgentsResumeOptions
  ): ReturnType<CloudflareAgentsResumeRun>;
}

export type CloudflarePlatformPrefixGuard<Env> = (
  options: CloudflarePlatformPrefixGuardOptions<Env>
) => MaybePromise<boolean>;

export interface CloudflarePlatformPrefixGuardOptions<Env>
  extends CloudflareAgentsPrefixGuardOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  readonly env: Env;
}

export function createCloudflarePlatformContext<
  Env,
  CreatedAgent extends CloudflareAgentsResumableAgent,
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>({
  allowPrefix,
  allowedPrefixes,
  cloudflareAgent,
  createAgent,
  defaultPrefix: contextDefaultPrefix = defaultPrefix,
  delayedResumeCallback,
  drain,
  durableObjectContext,
  env,
  retryMaxAttempts,
  retryMaxRunAfterMs,
  retryRunAfterMs,
}: CloudflarePlatformContextOptions<
  Env,
  CreatedAgent,
  TAgent
>): CloudflarePlatformContext<CreatedAgent> {
  const retry = createCloudflareAgentsFiberRetryScheduler({
    cloudflareAgent,
    delayedResumeCallback,
    retryMaxAttempts,
    retryMaxRunAfterMs,
    retryRunAfterMs,
    storage: durableObjectContext.storage,
  });
  const createHost = (prefix = contextDefaultPrefix): AgentHost =>
    createCloudflareHost({
      cloudflareAgent,
      delayedResumeCallback,
      drain,
      durableObjectContext,
      prefix,
      retryMaxAttempts,
      retryMaxRunAfterMs,
      retryRunAfterMs,
      resume: async (payload, options): ReturnType<CloudflareAgentsResumeRun> =>
        await (await createContextAgent(payload.prefix)).resume(
          payload.runId,
          options
        ),
    });
  const createContextAgent = async (
    prefix = contextDefaultPrefix
  ): Promise<CreatedAgent> =>
    await createAgent({
      cloudflareAgent,
      durableObjectContext,
      env,
      host: createHost(prefix),
      prefix,
    });
  const trust: CloudflareAgentsPayloadTrustOptions = {
    allowPrefix: allowPrefix
      ? (options) =>
          allowPrefix({
            cloudflareAgent,
            durableObjectContext,
            env,
            ...options,
          })
      : undefined,
    allowedPrefixes:
      allowedPrefixes ?? (allowPrefix ? undefined : [contextDefaultPrefix]),
  };

  return {
    agent: createContextAgent,
    host: createHost,
    recoverFiber: async (ctx) =>
      await recoverCloudflareAgentsFiber({
        ctx,
        drain,
        retry,
        resume: async (
          payload,
          options
        ): ReturnType<CloudflareAgentsResumeRun> =>
          await (await createContextAgent(payload.prefix)).resume(
            payload.runId,
            options
          ),
        storage: durableObjectContext.storage,
        ...trust,
      }),
    resumeScheduledFiber: async (payload) =>
      await resumeScheduledCloudflareAgentsFiber({
        cloudflareAgent,
        drain,
        payload,
        retry,
        resume: async (
          payload,
          options
        ): ReturnType<CloudflareAgentsResumeRun> =>
          await (await createContextAgent(payload.prefix)).resume(
            payload.runId,
            options
          ),
        storage: durableObjectContext.storage,
        ...trust,
      }),
  };
}
