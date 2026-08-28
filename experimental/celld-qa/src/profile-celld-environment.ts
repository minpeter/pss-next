import type { ProfilePlan } from "./profile-types";

const DEFAULT_PROFILE_ACTIVATIONS = "128";

export function applyProfileCelldEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: ProfilePlan["kind"]
): () => void {
  if (profile !== "wide" || environment.CELLD_ACTIVATIONS !== undefined) {
    return () => undefined;
  }
  environment.CELLD_ACTIVATIONS = DEFAULT_PROFILE_ACTIVATIONS;
  return () => {
    Reflect.deleteProperty(environment, "CELLD_ACTIVATIONS");
  };
}

export async function withProfileCelldEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  profile: ProfilePlan["kind"],
  operation: () => Promise<T>
): Promise<T> {
  const restore = applyProfileCelldEnvironment(environment, profile);
  try {
    return await operation();
  } finally {
    restore();
  }
}
