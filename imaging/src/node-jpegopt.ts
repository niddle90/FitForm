/**
 * Node.js loader for compress's optional native WASM engine.
 *
 * Deliberately kept separate from node-codecs.ts: this file imports
 * nothing from `@jsquash/*` or `@embedpdf/pdfium`, so a consumer who only
 * wants compress's faster/deterministic engine never needs those five
 * packages installed at all — unlike node-codecs.ts's other codecs,
 * jpegopt has no npm peer dependency of its own; the wasm binary ships
 * directly inside this package (wasm/jpegopt.wasm).
 *
 * Import from 'imaging/node', not from the package root — same
 * reasoning as node-codecs.ts: keeps `node:fs` out of any browser bundle.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJpegOptEngineFromBinary, type JpegOptEngine } from './jpegopt-engine.js';

export interface JpegOptNodeOptions {
  /** Override the path jpegopt.wasm is read from. Default: the bundled asset. */
  wasmPath?: string;
}

export async function createJpegOptEngineNode(
  options: JpegOptNodeOptions = {},
): Promise<JpegOptEngine> {
  const path = options.wasmPath ?? fileURLToPath(new URL('../wasm/jpegopt.wasm', import.meta.url));
  const wasmBinary = readFileSync(path);
  return createJpegOptEngineFromBinary(wasmBinary);
}
