export interface EchoCallResult {
  readonly commitCount: number;
  readonly historyCount: number;
  readonly reply: string;
}

export async function callEcho(
  fetchImpl: typeof fetch,
  baseUrl: string,
  objectName: string,
  idempotencyKey?: string
): Promise<EchoCallResult> {
  const response = await fetchImpl(
    `${baseUrl}/?object=${encodeURIComponent(objectName)}`,
    {
      body: JSON.stringify({
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        text: "hello",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const payload: unknown = await response.json();
  if (
    !response.ok ||
    typeof payload !== "object" ||
    payload === null ||
    !("historyCount" in payload) ||
    typeof payload.historyCount !== "number" ||
    !("commitCount" in payload) ||
    typeof payload.commitCount !== "number" ||
    !("reply" in payload) ||
    typeof payload.reply !== "string"
  ) {
    throw new Error(`matrix call failed: ${response.status}`);
  }
  return {
    commitCount: payload.commitCount,
    historyCount: payload.historyCount,
    reply: payload.reply,
  };
}
