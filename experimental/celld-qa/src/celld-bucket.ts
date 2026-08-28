const DEFAULT_ENDPOINT = "http://127.0.0.1:14566";
const DEFAULT_BUCKET = "pss-celld-qa";
const CLEANUP_CONCURRENCY = 16;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface CleanupOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function cleanupPrefix(
  prefix: string,
  options: CleanupOptions = {}
): Promise<void> {
  const endpoint =
    options.endpoint ?? process.env.S3_ENDPOINT ?? DEFAULT_ENDPOINT;
  const bucket = process.env.CELLD_QA_BUCKET ?? DEFAULT_BUCKET;
  const fetchImpl = options.fetchImpl ?? fetch;
  assertLoopbackEndpoint(endpoint);
  const scopedPrefix = `${prefix}/`;
  let continuation: string | undefined;
  do {
    const page = await listPrefix(
      scopedPrefix,
      continuation,
      endpoint,
      bucket,
      fetchImpl
    );
    assertKeysInsidePrefix(page.keys, scopedPrefix);
    await deleteKeys(page.keys, endpoint, bucket, fetchImpl);
    continuation = page.continuation;
  } while (continuation !== undefined);

  const verification = await listPrefix(
    scopedPrefix,
    undefined,
    endpoint,
    bucket,
    fetchImpl
  );
  assertKeysInsidePrefix(verification.keys, scopedPrefix);
  if (verification.keys.length > 0) {
    throw new Error(`bucket prefix is not empty after cleanup: ${prefix}`);
  }
}

export async function countPrefixObjects(
  prefix: string,
  options: CleanupOptions = {}
): Promise<number> {
  const endpoint =
    options.endpoint ?? process.env.S3_ENDPOINT ?? DEFAULT_ENDPOINT;
  const bucket = process.env.CELLD_QA_BUCKET ?? DEFAULT_BUCKET;
  const fetchImpl = options.fetchImpl ?? fetch;
  assertLoopbackEndpoint(endpoint);
  const scopedPrefix = `${prefix}/`;
  let continuation: string | undefined;
  let count = 0;
  do {
    const page = await listPrefix(
      scopedPrefix,
      continuation,
      endpoint,
      bucket,
      fetchImpl
    );
    assertKeysInsidePrefix(page.keys, scopedPrefix);
    count += page.keys.length;
    continuation = page.continuation;
  } while (continuation !== undefined);
  return count;
}

async function listPrefix(
  prefix: string,
  continuation: string | undefined,
  endpoint: string,
  bucket: string,
  fetchImpl: typeof fetch
): Promise<{
  readonly continuation: string | undefined;
  readonly keys: string[];
}> {
  const query = new URLSearchParams({
    "list-type": "2",
    prefix,
    ...(continuation === undefined
      ? {}
      : { "continuation-token": continuation }),
  });
  const response = await fetchImpl(`${endpoint}/${bucket}?${query}`);
  if (!response.ok) {
    throw new Error(`bucket listing failed: ${response.status}`);
  }
  const xml = await response.text();
  return {
    continuation: decodeTag(xml, "NextContinuationToken"),
    keys: [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
      decodeXml(match[1] ?? "")
    ),
  };
}

function assertKeysInsidePrefix(keys: readonly string[], prefix: string): void {
  const foreignKey = keys.find((key) => !key.startsWith(prefix));
  if (foreignKey !== undefined) {
    throw new Error(
      `bucket listing returned key outside cleanup prefix: ${foreignKey}`
    );
  }
}

async function deleteKeys(
  keys: readonly string[],
  endpoint: string,
  bucket: string,
  fetchImpl: typeof fetch
): Promise<void> {
  let nextIndex = 0;
  const deleteNext = async (): Promise<void> => {
    while (nextIndex < keys.length) {
      const key = keys[nextIndex];
      nextIndex += 1;
      if (key === undefined) {
        return;
      }
      const deleted = await fetchImpl(
        `${endpoint}/${bucket}/${encodeKey(key)}`,
        { method: "DELETE" }
      );
      if (!deleted.ok && deleted.status !== 404) {
        throw new Error(`bucket object cleanup failed: ${deleted.status}`);
      }
    }
  };
  const workerCount = Math.min(CLEANUP_CONCURRENCY, keys.length);
  await Promise.all(Array.from({ length: workerCount }, deleteNext));
}

export function assertLoopbackEndpoint(endpoint: string): void {
  const hostname = new URL(endpoint).hostname;
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(`Celld QA endpoint must be loopback: ${hostname}`);
  }
}

function decodeTag(xml: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
