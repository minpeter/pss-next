import type { DurableObjectStorage } from "../../storage/durable-object/durable-object-storage";

export type CloudflareDurableObjectId = unknown;

export interface CloudflareDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareDurableObjectNamespace<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> {
  get(id: CloudflareDurableObjectId): Stub;
  idFromName(name: string): CloudflareDurableObjectId;
}

export interface CloudflareDurableObjectState {
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export interface CloudflareDurableObjectStubOptions<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> {
  readonly namespace?: CloudflareDurableObjectNamespace<Stub>;
  readonly objectName: string;
}

export interface CloudflareDurableObjectFetchOptions<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
> extends CloudflareDurableObjectStubOptions<Stub> {
  readonly request: Request;
}

export function getCloudflareDurableObjectStub<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
>({
  namespace,
  objectName,
}: CloudflareDurableObjectStubOptions<Stub>): Stub | undefined {
  return namespace?.get(namespace.idFromName(objectName));
}

export async function fetchCloudflareDurableObject<
  Stub extends CloudflareDurableObjectStub = CloudflareDurableObjectStub,
>({
  request,
  ...options
}: CloudflareDurableObjectFetchOptions<Stub>): Promise<Response | undefined> {
  return await getCloudflareDurableObjectStub(options)?.fetch(request);
}
