/// <reference path="../../types/heic-decode.d.ts" />
/// <reference path="../../types/libheif-js.d.ts" />
import { getInstalledImageCodecWasm } from "./attachment-image-codec-registry";
import { ensureImageCodecRuntimeReady } from "./attachment-image-decode-runtime";
import { asUint8Array, type RgbaImage } from "./attachment-image-rgba";

export async function decodeHeicToRgba(bytes: Uint8Array): Promise<RgbaImage> {
  try {
    return await decodeHeicWithLibheifEsm(bytes);
  } catch (edgeError) {
    // Node fallback
    try {
      const decode = (await import("heic-decode")).default;
      const decoded = await decode({
        buffer: bytes as unknown as ArrayBuffer,
      });
      return {
        data: asUint8Array(decoded.data),
        height: decoded.height,
        width: decoded.width,
      };
    } catch {
      throw edgeError;
    }
  }
}

interface LibheifImage {
  display: (
    imageData: {
      data: Uint8ClampedArray;
      height: number;
      width: number;
    },
    callback: (
      displayData: {
        data: Uint8ClampedArray;
        height: number;
        width: number;
      } | null
    ) => void
  ) => void;
  free: () => void;
  get_height: () => number;
  get_width: () => number;
}

interface LibheifModule {
  HeifDecoder: new () => {
    decode: (buffer: Uint8Array) => LibheifImage[];
    decoder: { delete: () => void };
  };
  ready: Promise<void>;
}

/** Cached libheif module — Wasm.Instance is expensive; reuse across HEIC decodes. */
let libheifModulePromise: Promise<LibheifModule> | undefined;
/**
 * Serialize HEIC decodes: a single libheif Wasm instance is not safe for
 * concurrent decode/display (Promise.all of HEIC attachments fails with
 * "HEIF processing error").
 */
let heicDecodeGate: Promise<void> = Promise.resolve();

async function getLibheifModule(): Promise<LibheifModule> {
  if (!libheifModulePromise) {
    libheifModulePromise = (async () => {
      // Workers + nodejs_compat: emscripten may probe Node and touch __dirname.
      polyfillEmscriptenNodeShims();
      await ensureImageCodecRuntimeReady();

      const heifWasm = getInstalledImageCodecWasm().heifDecodeWasm as
        | WebAssembly.Module
        | undefined;
      if (!heifWasm) {
        throw new Error(
          "HEIF decode wasm is not installed. On Cloudflare Workers, import image-codecs-edge (static libheif.wasm)."
        );
      }

      // ESM glue with instantiateWasm so Workers never compile wasm from raw bytes.
      const factory = (
        await import("libheif-js/libheif-wasm/libheif-bundle.mjs")
      ).default as (options?: object) => LibheifModule;

      const libheif =
        typeof factory === "function"
          ? factory({
              instantiateWasm(
                imports: WebAssembly.Imports,
                successCallback: (
                  instance: WebAssembly.Instance,
                  module: WebAssembly.Module
                ) => void
              ) {
                const instance = new WebAssembly.Instance(heifWasm, imports);
                successCallback(instance, heifWasm);
                return instance.exports;
              },
            })
          : factory;

      if (libheif.ready) {
        await libheif.ready;
      }
      return libheif;
    })();
  }
  try {
    return await libheifModulePromise;
  } catch (error) {
    // Allow retry after a failed cold init (e.g. missing wasm in tests).
    libheifModulePromise = undefined;
    throw error;
  }
}

async function decodeHeicWithLibheifEsm(bytes: Uint8Array): Promise<RgbaImage> {
  const previous = heicDecodeGate;
  let release!: () => void;
  heicDecodeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await decodeHeicWithLibheifEsmUnlocked(bytes);
  } finally {
    release();
  }
}

async function decodeHeicWithLibheifEsmUnlocked(
  bytes: Uint8Array
): Promise<RgbaImage> {
  const libheif = await getLibheifModule();
  const decoder = new libheif.HeifDecoder();
  let images: LibheifImage[] = [];
  try {
    images = decoder.decode(bytes);
    if (!images.length) {
      throw new Error("HEIF image not found");
    }
    const image = images[0];
    if (!image) {
      throw new Error("HEIF image not found");
    }
    const width = image.get_width();
    const height = image.get_height();
    const displayData = await new Promise<{
      data: Uint8ClampedArray;
      height: number;
      width: number;
    }>((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (!result) {
            reject(new Error("HEIF processing error"));
            return;
          }
          resolve(result);
        }
      );
    });
    return {
      data: asUint8Array(displayData.data),
      height: displayData.height,
      width: displayData.width,
    };
  } finally {
    for (const image of images) {
      try {
        image.free();
      } catch {
        // ignore
      }
    }
    try {
      decoder.decoder.delete();
    } catch {
      // ignore
    }
  }
}

/** Provide harmless values for Emscripten's Node probes in Workers. */
function polyfillEmscriptenNodeShims(): void {
  const g = globalThis as typeof globalThis & {
    __dirname?: string;
    __filename?: string;
  };
  if (typeof g.__dirname !== "string") {
    g.__dirname = "/";
  }
  if (typeof g.__filename !== "string") {
    g.__filename = "/libheif.js";
  }
}
