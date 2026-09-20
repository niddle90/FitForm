/**
 * Browser loader for compress's optional native WASM engine.
 *
 * Deliberately kept separate from browser-codecs.ts: this file imports
 * nothing from `@jsquash/*` or `@embedpdf/pdfium`, so a consumer who only
 * wants compress's faster/deterministic engine — and none of the other
 * tools — never pulls those five packages into their bundle at all.
 *
 * `jpegopt.wasm` ships inside this package (wasm/jpegopt.wasm), unlike
 * the jSquash/pdfium assets, which live in packages the consumer installs
 * themselves. Two ways to point this loader at it:
 *
 *   1. (default, zero config) `new URL('../wasm/jpegopt.wasm',
 *      import.meta.url)` — resolved relative to *this installed package*,
 *      not the consumer's app. Every mainstream bundler (Vite, webpack 5,
 *      esbuild, Rollup via @rollup/plugin-url) recognizes the
 *      `new URL(..., import.meta.url)` pattern and automatically copies
 *      the referenced asset into the build output with a correct
 *      content-hashed URL — no manual "copy this wasm file to your
 *      public dir" step required, unlike the peer-dependency assets in
 *      browser-codecs.ts (those live under an arbitrary consumer
 *      node_modules path a bundler has no reason to know about).
 *   2. Pass `assetUrl` yourself if you'd rather host the file at a
 *      specific path (e.g. serving it from your own CDN).
 */

import { createJpegOptEngineFromBinary, type JpegOptEngine } from './jpegopt-engine.js';

export interface JpegOptBrowserOptions {
  /** Override where jpegopt.wasm is fetched from. Default: see file comment above. */
  assetUrl?: string | URL;
}

export async function createJpegOptEngineBrowser(
  options: JpegOptBrowserOptions = {},
): Promise<JpegOptEngine> {
  const url = options.assetUrl ?? new URL('../wasm/jpegopt.wasm', import.meta.url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch jpegopt.wasm: ${res.status} ${res.statusText}`);
  }
  const wasmBinary = await res.arrayBuffer();
  return createJpegOptEngineFromBinary(wasmBinary);
}
