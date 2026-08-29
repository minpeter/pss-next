import type {
  HostAttachmentStore,
  RuntimeAttachmentBlob,
  RuntimeAttachmentPutInput,
  RuntimeAttachmentReference,
} from "../../../thread/input/attachments";
import type { DurableObjectTransactionStorage } from "./durable-object/durable-object-storage";

interface StoredDurableObjectAttachment {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly id: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

class DurableObjectAttachmentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableObjectAttachmentStoreError";
  }
}

const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DurableObjectAttachmentStore implements HostAttachmentStore {
  readonly #prefix: string;
  readonly #storage: DurableObjectTransactionStorage;

  constructor({
    prefix = "pss-runtime",
    storage,
  }: {
    readonly prefix?: string;
    readonly storage: DurableObjectTransactionStorage;
  }) {
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async delete(ref: RuntimeAttachmentReference): Promise<void> {
    assertAttachmentId(ref.id);
    await this.#storage.delete(this.#key(ref.id));
  }

  async get(
    ref: RuntimeAttachmentReference
  ): Promise<RuntimeAttachmentBlob | null> {
    assertAttachmentId(ref.id);
    const stored = await this.#storage.get<StoredDurableObjectAttachment>(
      this.#key(ref.id)
    );
    if (!stored) {
      return null;
    }

    return {
      bytes: new Uint8Array(stored.bytes),
      filename: stored.filename,
      mediaType: stored.mediaType,
      ref: durableObjectReference(stored),
    };
  }

  async put(
    input: RuntimeAttachmentPutInput
  ): Promise<RuntimeAttachmentReference> {
    const stored: StoredDurableObjectAttachment = {
      bytes: new Uint8Array(input.bytes),
      filename: input.filename,
      id: crypto.randomUUID(),
      mediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
    };
    await this.#storage.put(this.#key(stored.id), stored);
    return durableObjectReference(stored);
  }

  #key(id: string): string {
    return `${this.#prefix}:attachment:${id}`;
  }
}

function assertAttachmentId(id: string): void {
  if (!attachmentIdPattern.test(id)) {
    throw new DurableObjectAttachmentStoreError(
      "Invalid DurableObjectAttachmentStore ref id."
    );
  }
}

function durableObjectReference(
  stored: StoredDurableObjectAttachment
): RuntimeAttachmentReference {
  return {
    id: stored.id,
    schemaVersion: 1,
    sizeBytes: stored.sizeBytes,
    source: "durable-object",
  };
}
