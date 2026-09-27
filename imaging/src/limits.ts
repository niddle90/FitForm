/**
 * Shared sanity bounds for anything that turns attacker-controlled header
 * fields (BMP/TGA width+height, a PDF page's MediaBox) into a pixel-buffer
 * allocation.
 *
 * Every one of these paths reads a *declared* dimension from the input
 * before knowing whether the file actually has that much data behind it.
 * Without a cap, a file of a few dozen bytes can declare an arbitrary
 * width/height and force an allocation sized to match — this is the classic
 * "decompression bomb" shape, except there's no compression involved at
 * all: it's just an unchecked header field feeding `new Uint8ClampedArray(w
 * * h * 4)` (or, for pdfToImages, `FPDFBitmap_Create(w, h, 0)`).
 *
 * These numbers are deliberately generous — comparable to or larger than
 * real browser canvas limits (Chrome's max canvas area is ~268 megapixels
 * per side-dimension caps around 32767px; Safari is much stricter, closer
 * to 16 megapixels) — so legitimate large images/pages still work. The
 * point isn't to guess a "correct" limit, it's to make sure *some* finite
 * limit exists before an allocation call, so a malformed or hostile input
 * fails with a clean, categorized `VaultError` instead of an uncaught
 * `RangeError` (or, worse, actually exhausting available memory first).
 */

import { VaultError } from './errors.js';

/** No single side may exceed this many pixels. */
export const MAX_IMAGE_DIMENSION = 20_000;

/** Total pixel count (width * height) may not exceed this. */
export const MAX_IMAGE_PIXELS = 60_000_000; // ~229MB as RGBA — generous, not unlimited

/**
 * Maximum size, in bytes, of an *encoded* input file (JPEG/PNG/WebP/PDF/…)
 * accepted at any public entry point that takes raw file bytes.
 *
 * This is a different axis from MAX_IMAGE_DIMENSION/MAX_IMAGE_PIXELS above:
 * those bound the *decoded* pixel buffer a declared width/height can force.
 * This one bounds the *encoded* file itself, before it's ever decoded —
 * a small, valid-looking image can still be wrapped in an enormous byte
 * stream (padding, garbage trailing data, a deliberately bloated file), and
 * every one of these entry points copies the whole input into WASM memory
 * (`mod.HEAPU8.set(input, inPtr)`) or hands it to a canvas/PDFium decoder
 * as one contiguous buffer before any pixel-level guard ever runs. For a
 * mobile-first browser app, that copy alone is worth bounding.
 *
 * 100MB is deliberately generous for a photo/PDF editing tool — this exists
 * to catch pathological/hostile input, not to constrain normal use.
 */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

export function assertSaneInputSize(tool: string, input: Uint8Array, context: string): void {
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new VaultError(
      tool,
      'MEMORY',
      `${context}: input is ${(input.byteLength / (1024 * 1024)).toFixed(1)}MB, which exceeds the ` +
        `maximum supported input size (${MAX_INPUT_BYTES / (1024 * 1024)}MB)`,
    );
  }
}

export function assertSaneImageDimensions(
  tool: string,
  width: number,
  height: number,
  context: string,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new VaultError(tool, 'FORMAT', `${context}: invalid dimensions ${width}x${height}`);
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new VaultError(
      tool,
      'MEMORY',
      `${context}: ${width}x${height} exceeds the maximum supported side length (${MAX_IMAGE_DIMENSION}px)`,
    );
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new VaultError(
      tool,
      'MEMORY',
      `${context}: ${width}x${height} (${(width * height).toLocaleString()}px) exceeds the maximum ` +
        `supported pixel count (${MAX_IMAGE_PIXELS.toLocaleString()}px)`,
    );
  }
}

/**
 * Same size ceiling as assertSaneImageDimensions, but for public *encoder*
 * entry points (encodeBmp/encodeTga) — the dimensions here come from the
 * caller's own ImageData, not a declared field decoded out of an untrusted
 * file, so a bad value is a caller/argument error (ARGS), not a FORMAT or
 * MEMORY one. This also rejects non-integer width/height before they reach
 * a binary header: TGA's width/height fields are 16-bit (max 65535), and
 * MAX_IMAGE_DIMENSION (20,000) is comfortably under that, so passing this
 * check also guarantees a TGA header field can't silently wrap.
 */
export function assertEncodableImageDimensions(tool: string, width: number, height: number, format: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new VaultError(
      tool,
      'ARGS',
      `${format}: width and height must be positive integers, got ${width}x${height}`,
    );
  }
  assertSaneImageDimensions(tool, width, height, `${format} encode`);
}
