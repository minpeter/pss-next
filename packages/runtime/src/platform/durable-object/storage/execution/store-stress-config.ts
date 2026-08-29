import type { MockAgentStorageScenarioConfig } from "./store-stress-scenario";

const storageStressProfile = process.env.PSS_RUNTIME_STORAGE_STRESS_PROFILE;

export const isExtremeStorageStressProfile = storageStressProfile === "extreme";

export const mockAgentStressConfig =
  resolveMockAgentStressConfig(storageStressProfile);

export function extremeAwareTimeout(defaultTimeoutMs: number): number {
  return isExtremeStorageStressProfile ? 300_000 : defaultTimeoutMs;
}

function resolveMockAgentStressConfig(
  profile: string | undefined
): MockAgentStorageScenarioConfig {
  if (profile === "extreme") {
    return {
      agentCount: 5,
      assistantPayloadBytes: 32_768,
      checkpointPayloadBytes: 16_384,
      eventPayloadBytes: 24_576,
      largeAssistantStride: 1,
      maxPayloadBytes: 8192,
      notificationPayloadBytes: 32_768,
      prefix: "mock-agent-storage-stress-extreme",
      targetStoredChunkBytes: 200 * 1024 * 1024,
      threadCommitStride: 4,
      threadsPerUser: 2,
      turnsPerThread: 20,
      usersPerAgent: 10,
    };
  }
  if (profile === "torture") {
    return {
      agentCount: 8,
      assistantPayloadBytes: 1536,
      checkpointPayloadBytes: 0,
      eventPayloadBytes: 0,
      largeAssistantStride: 4,
      maxPayloadBytes: 512,
      notificationPayloadBytes: 0,
      prefix: "mock-agent-storage-stress-torture",
      targetStoredChunkBytes: 0,
      threadCommitStride: 4,
      threadsPerUser: 4,
      turnsPerThread: 24,
      usersPerAgent: 20,
    };
  }
  if (profile === "heavy") {
    return {
      agentCount: 8,
      assistantPayloadBytes: 1536,
      checkpointPayloadBytes: 0,
      eventPayloadBytes: 0,
      largeAssistantStride: 4,
      maxPayloadBytes: 512,
      notificationPayloadBytes: 0,
      prefix: "mock-agent-storage-stress-heavy",
      targetStoredChunkBytes: 0,
      threadCommitStride: 2,
      threadsPerUser: 4,
      turnsPerThread: 24,
      usersPerAgent: 12,
    };
  }
  return {
    agentCount: 3,
    assistantPayloadBytes: 1536,
    checkpointPayloadBytes: 0,
    eventPayloadBytes: 0,
    largeAssistantStride: 4,
    maxPayloadBytes: 512,
    notificationPayloadBytes: 0,
    prefix: "mock-agent-storage-stress",
    targetStoredChunkBytes: 0,
    threadCommitStride: 1,
    threadsPerUser: 3,
    turnsPerThread: 10,
    usersPerAgent: 4,
  };
}
