import {
  getInstalledImageCodecWasm,
  hasAvifDecodeWasm,
  hasHeifDecodeWasm,
  hasWebpDecodeWasm,
  installImageCodecWasmFromNodeModules,
} from "./attachment-image-codec-registry";
import {
  asUint8Array,
  type RgbaImage,
  toArrayBuffer,
} from "./attachment-image-rgba";

let avifInitPromise: Promise<void> | undefined;
let webpInitPromise: Promise<void> | undefined;
let runtimeReadyPromise: Promise<void> | undefined;

function hasAllImageDecodeWasm(): boolean {
  return hasAvifDecodeWasm() && hasWebpDecodeWasm() && hasHeifDecodeWasm();
}

/**
 * Load codec wasm for the current runtime.
 * 1) Already installed (Worker static imports / app bootstrap)
 * 2) Node: read wasm from node_modules
 * 3) Edge bundle: dynamic-import image-codecs-edge (static wasm imports inside)
 *
 * Never relies on bare jSquash `init()` network fetch — that breaks on Workers.
 * Never compiles wasm from raw bytes on Workers (embedder forbids it).
 */
export async function ensureImageCodecRuntimeReady(): Promise<void> {
  if (runtimeReadyPromise) {
    await runtimeReadyPromise;
    return;
  }
  runtimeReadyPromise = (async () => {
    if (hasAllImageDecodeWasm()) {
      return;
    }
    await installImageCodecWasmFromNodeModules();
    if (hasAllImageDecodeWasm()) {
      return;
    }
    try {
      // Wrangler follows this static specifier and bundles .wasm imports.
      const edge = await import(
        "../../platform/durable-object/cloudflare/image-codecs-edge.js"
      );
      edge.installCloudflareImageCodecs();
    } catch {
      // Not bundled (e.g. pure Node unit path without edge entry).
    }
  })();
  await runtimeReadyPromise;
}

async function ensureAvifDecoderInitialized(): Promise<void> {
  if (!avifInitPromise) {
    avifInitPromise = (async () => {
      await ensureImageCodecRuntimeReady();
      const wasm = getInstalledImageCodecWasm().avifDecodeWasm;
      if (!wasm) {
        throw new Error(
          "AVIF decode wasm is not installed. On Cloudflare Workers, import @minpeter/pss-runtime/platform/durable-object/cloudflare (image-codecs-edge) or call installImageCodecWasm()."
        );
      }
      const mod = await import("@jsquash/avif/decode.js");
      await mod.init(wasm as WebAssembly.Module);
    })();
  }
  await avifInitPromise;
}

async function ensureWebpDecoderInitialized(): Promise<void> {
  if (!webpInitPromise) {
    webpInitPromise = (async () => {
      await ensureImageCodecRuntimeReady();
      const wasm = getInstalledImageCodecWasm().webpDecodeWasm;
      if (!wasm) {
        throw new Error(
          "WebP decode wasm is not installed. On Cloudflare Workers, import @minpeter/pss-runtime/platform/durable-object/cloudflare (image-codecs-edge) or call installImageCodecWasm()."
        );
      }
      const mod = await import("@jsquash/webp/decode.js");
      await mod.init(wasm as WebAssembly.Module);
    })();
  }
  await webpInitPromise;
}

export async function decodeAvifToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  await ensureAvifDecoderInitialized();
  const { default: decode } = await import("@jsquash/avif/decode.js");
  const decoded = await decode(toArrayBuffer(bytes));
  if (!decoded) {
    throw new Error("AVIF decoder returned no image data.");
  }
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
}

export async function decodeWebpToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  await ensureWebpDecoderInitialized();
  const { default: decode } = await import("@jsquash/webp/decode.js");
  const decoded = await decode(toArrayBuffer(bytes));
  if (!decoded) {
    throw new Error("WebP decoder returned no image data.");
  }
  return {
    data: asUint8Array(decoded.data),
    height: decoded.height,
    width: decoded.width,
  };
}
