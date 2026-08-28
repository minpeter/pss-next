export interface CampaignLifecycleOptions<T> {
  readonly cleanup: () => Promise<void>;
  readonly run: () => Promise<T>;
}

export async function runWithCampaignCleanup<T>({
  cleanup,
  run,
}: CampaignLifecycleOptions<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (primaryError) {
    await Promise.allSettled([cleanup()]);
    throw primaryError;
  }
  await cleanup();
  return result;
}
