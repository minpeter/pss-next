/// <reference path="../../../types/wasm.d.ts" />
/**
 * Cloudflare Workers / edge bootstrap for image attachment codecs.
 *
 * jSquash + libheif require static wasm imports on Workers:
 * - no dynamic fetch of wasm
 * - no `new WebAssembly.Module(bytes)` (disallowed by embedder)
 *
 * @see https://github.com/jamsinclair/jSquash#usage-in-cloudflare-workers
 * @see https://developers.cloudflare.com/workers/runtime-apis/webassembly/
 */

import AVIF_DEC_WASM from "@jsquash/avif/codec/dec/avif_dec.wasm";
import WEBP_DEC_WASM from "@jsquash/webp/codec/dec/webp_dec.wasm";
import HEIF_DEC_WASM from "libheif-js/libheif-wasm/libheif.wasm";

import { installImageCodecWasm } from "../../../thread/input/attachment-image-codec-registry";

let installed = false;

/**
 * Idempotently install edge wasm codecs (AVIF, WebP, HEIF/HEIC).
 */
export function installCloudflareImageCodecs(): void {
  if (installed) {
    return;
  }
  installImageCodecWasm({
    avifDecodeWasm: AVIF_DEC_WASM,
    heifDecodeWasm: HEIF_DEC_WASM,
    webpDecodeWasm: WEBP_DEC_WASM,
  });
  installed = true;
}
