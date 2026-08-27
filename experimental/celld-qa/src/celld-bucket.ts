const ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:14566";
const BUCKET = process.env.CELLD_QA_BUCKET ?? "pss-celld-qa";

export async function cleanupPrefix(prefix: string): Promise<void> {
  let continuation: string | undefined;
  do {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix: `${prefix}/`,
      ...(continuation === undefined
        ? {}
        : { "continuation-token": continuation }),
    });
    const response = await fetch(`${ENDPOINT}/${BUCKET}?${query}`);
    if (!response.ok) {
      throw new Error(`bucket listing failed: ${response.status}`);
    }
    const xml = await response.text();
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
      decodeXml(match[1] ?? "")
    );
    await Promise.all(
      keys.map(async (key) => {
        const deleted = await fetch(`${ENDPOINT}/${BUCKET}/${encodeKey(key)}`, {
          method: "DELETE",
        });
        if (!deleted.ok && deleted.status !== 404) {
          throw new Error(`bucket object cleanup failed: ${deleted.status}`);
        }
      })
    );
    continuation = decodeTag(xml, "NextContinuationToken");
  } while (continuation !== undefined);
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
