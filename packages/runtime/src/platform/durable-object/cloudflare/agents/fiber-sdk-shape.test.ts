import type {
  Agent as CloudflareSdkAgent,
  FiberContext as CloudflareSdkFiberContext,
  StartFiberOptions as CloudflareSdkStartFiberOptions,
  StartFiberResult as CloudflareSdkStartFiberResult,
} from "agents";
import { describe, expect, it } from "vitest";
import {
  type CloudflareAgentsDefaultResumeAgent,
  type CloudflareAgentsDurableObjectContext,
  type CloudflareAgentsFiberContext,
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsSchedule,
  type CloudflareAgentsScheduleOptions,
  type CloudflareAgentsStartFiberOptions,
  type CloudflareAgentsStartFiberResult,
  createCloudflareHost,
} from "./index";
import { createFakeCloudflareAgent, runWithText } from "./test-support";

type IsAssignable<Source, Target> = Source extends Target ? true : false;
type AssertTrue<T extends true> = T;
interface RealPssCloudflareAgent extends CloudflareSdkAgent {
  resumePssRuntimeFiber(payload: unknown): Promise<void>;
}

type RealCloudflareAgentPort = Pick<
  RealPssCloudflareAgent,
  "resumePssRuntimeFiber" | "schedule" | "startFiber"
>;
type SdkStartResultMatchesAdapter = AssertTrue<
  IsAssignable<CloudflareSdkStartFiberResult, CloudflareAgentsStartFiberResult>
>;
type AdapterStartResultMatchesSdk = AssertTrue<
  IsAssignable<CloudflareAgentsStartFiberResult, CloudflareSdkStartFiberResult>
>;
type AdapterStartOptionsMatchSdk = AssertTrue<
  IsAssignable<
    CloudflareAgentsStartFiberOptions,
    CloudflareSdkStartFiberOptions
  >
>;
type SdkFiberContextMatchesAdapter = AssertTrue<
  IsAssignable<CloudflareSdkFiberContext, CloudflareAgentsFiberContext>
>;
type RealCloudflareAgentMatchesAdapter = AssertTrue<
  IsAssignable<RealCloudflareAgentPort, CloudflareAgentsDefaultResumeAgent>
>;

const sdkTypeAssertions: readonly [
  SdkStartResultMatchesAdapter,
  AdapterStartResultMatchesSdk,
  AdapterStartOptionsMatchSdk,
  SdkFiberContextMatchesAdapter,
  RealCloudflareAgentMatchesAdapter,
] = [true, true, true, true, true];

describe("Cloudflare Agents SDK shape", () => {
  it("accepts a subclass shape with protected ctx", async () => {
    const cloudflareAgent = new AgentsSdkShapeFixture();
    const host = cloudflareAgent.createPssRuntimeHost();

    await host.scheduler.enqueueRun("background:bg_sdk_shape");

    expect(cloudflareAgent.startedFiberNames).toEqual([
      "pss-runtime:resume-run",
    ]);
    expect(cloudflareAgent.scheduledCallbacks).toEqual([]);
    expect(sdkTypeAssertions).toEqual([true, true, true, true, true]);
  });
});

class AgentsSdkShapeFixture {
  protected readonly ctx: CloudflareAgentsDurableObjectContext =
    createFakeCloudflareAgent().durableObjectContext;
  readonly scheduledCallbacks: string[] = [];
  readonly startedFiberNames: string[] = [];

  createPssRuntimeHost() {
    return createCloudflareHost({
      cloudflareAgent: this,
      durableObjectContext: this.ctx,
      prefix: "tenant-a",
      resume: (payload) => Promise.resolve(runWithText(payload.runId)),
    });
  }

  resumePssRuntimeFiber(_payload: unknown): Promise<void> {
    return Promise.resolve();
  }

  schedule<TPayload extends CloudflareAgentsFiberPayload>(
    _when: Date | number | string,
    callback: keyof this,
    payload: TPayload,
    _options?: CloudflareAgentsScheduleOptions
  ): Promise<CloudflareAgentsSchedule<TPayload>> {
    this.scheduledCallbacks.push(String(callback));
    return Promise.resolve({
      callback: String(callback),
      delayInSeconds: typeof _when === "number" ? _when : 0,
      id: `schedule-${this.scheduledCallbacks.length}`,
      payload,
      time: Date.now(),
      type: "delayed",
    });
  }

  async startFiber(
    name: string,
    fn: (ctx: CloudflareAgentsFiberContext) => Promise<void>,
    options?: CloudflareAgentsStartFiberOptions
  ): Promise<CloudflareAgentsStartFiberResult> {
    const fiberId = `fiber-${this.startedFiberNames.length + 1}`;
    let snapshot: unknown;
    await fn({
      id: fiberId,
      signal: new AbortController().signal,
      snapshot: null,
      stash: (value) => {
        snapshot = value;
      },
    });
    this.startedFiberNames.push(name);
    return {
      accepted: true,
      createdAt: Date.now(),
      fiberId,
      idempotencyKey: options?.idempotencyKey,
      metadata: options?.metadata,
      name,
      snapshot,
      status: "completed",
    };
  }
}
