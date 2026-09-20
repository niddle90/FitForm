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
