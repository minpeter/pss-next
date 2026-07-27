import {
  decideUpdateNotice,
  fetchDistTags,
  formatUpdateNotice,
  isCacheFresh,
  readUpdateCheckCache,
  resolveUpdateRegistryBaseUrl,
  type UpdateNotice,
  writeUpdateCheckCache,
} from "./check";
import { extractUpdateChannel } from "./version";

export interface UpdateNotifierDeps {
  readonly cachePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchTags?: () => Promise<Readonly<Record<string, string>>>;
  readonly now?: () => number;
  readonly schedule?: (task: () => Promise<void>) => void;
  readonly version: string | undefined;
  readonly write: (line: string) => void;
}

export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PSS_DISABLE_UPDATE_CHECK?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function emitUpdateNotice({
  write,
  env,
  version,
  cachePath,
  now = Date.now,
  fetchTags = () =>
    fetchDistTags({ baseUrl: resolveUpdateRegistryBaseUrl(env) }),
  schedule = defaultSchedule,
}: UpdateNotifierDeps): Promise<UpdateNotice | undefined> {
  // no-excuse-ok: catch — update notices are best-effort and must never break the session.
  try {
    if (version === undefined || isUpdateCheckDisabled(env)) {
      return;
    }

    let notice: UpdateNotice | undefined;
    const cache = await readUpdateCheckCache(cachePath);
    if (cache !== undefined) {
      notice = decideUpdateNotice(
        { version, channel: extractUpdateChannel(version) },
        cache.tags
      );
      if (notice !== undefined) {
        write(formatUpdateNotice(notice));
      }
      if (isCacheFresh(cache, now())) {
        return notice;
      }
    }

    schedule(() => refreshCacheBestEffort({ cachePath, now, fetchTags }));
    return notice;
  } catch {
    return;
  }
}

interface RefreshCacheOptions {
  readonly cachePath: string;
  readonly fetchTags: () => Promise<Readonly<Record<string, string>>>;
  readonly now: () => number;
}

async function refreshCacheBestEffort({
  cachePath,
  now,
  fetchTags,
}: RefreshCacheOptions): Promise<void> {
  try {
    const tags = await fetchTags();
    if (Object.keys(tags).length === 0) {
      return;
    }
    await writeUpdateCheckCache(cachePath, {
      checkedAt: new Date(now()).toISOString(),
      tags,
    });
  } catch {
    // Intentional degradation: a failed refresh only delays the next notice.
  }
}

const defaultSchedule = (task: () => Promise<void>): void => {
  task();
};
