/**
 * printLayout — lay out an image on an A4 print canvas at 300 DPI.
 * Browser port of xprint.c.
 *
 * Pipeline (migration_v3.md §2.3): decode -> resize (Lanczos) -> composite
 * onto a white A4 canvas -> encode JPEG.
 *
 *  - Resize: @jsquash/resize, method 'lanczos3' — kept as WASM unconditionally.
 *    This is the one stage in the whole suite the tolerance discussion left
 *    BLOCKED rather than open: existing evidence (a Firefox bug thread
 *    flagging aggressive-downscale resize as one of the more visibly
 *    divergent operations between engines) points *against* "not
 *    noticeable" for exactly printLayout's realistic case — large source photo
 *    downscaled onto a print-width layout. Do not swap this for
 *    `drawImage`/`imageSmoothingQuality` without the cross-browser
 *    perceptual measurement migration_v3.md §7 calls for.
 *  - Encode: @jsquash/jpeg — kept as WASM by default (migration_v3.md §2.3
 *    marks this "OPEN", default-keep-WASM until measured, not "resolved
 *    native"). There's no size target here, so if a future perceptual-delta
 *    measurement clears JPEG encode for this exact composited-canvas input,
 *    swapping to `canvas.convertToBlob` is a contained, local change.
 *  - Composite: plain pixel-buffer array indexing — never a WASM/library
 *    candidate in any revision of this plan.
 *
 * Known scope gap vs. the original: xprint.c decodes via ImageMagick, which
 * accepts arbitrary input formats. migration_v3.md's plan for this tool only
 * specifies `@jsquash/jpeg` for decode, so this port currently accepts JPEG
 * input only. Widening that (e.g. sniffing + also trying `@jsquash/png`)
 * is a straightforward follow-up, not attempted here since it wasn't part
 * of the approved architecture doc.
 */

import type { JpegCodec, ResizeCodec } from './codecs.js';
import { VaultError, silentLogger, type Logger } from './errors.js';
import { makeImageData } from './image-data.js';

const A4_WIDTH_CM = 21.0;
const A4_HEIGHT_CM = 29.7;
const TARGET_DPI = 300.0;

export interface PrintLayoutOptions {
  /** Scale image to this width in cm. Mutually exclusive with heightCm. */
  widthCm?: number;
  /** Scale image to this height in cm. Mutually exclusive with widthCm. */
  heightCm?: number;
  /** Top margin in cm. Default 0. */
  topCm?: number;
  /** Left offset in cm. Mutually exclusive with rightCm and center. */
  leftCm?: number;
  /** Right offset in cm. Mutually exclusive with leftCm and center. */
  rightCm?: number;
  /** Center image horizontally. Mutually exclusive with leftCm/rightCm. */
  center?: boolean;
  /**
   * JPEG output quality (0-100). xprint.c never set this explicitly and
   * relied on ImageMagick's JPEG-writer default (~92); 92 is used here as
   * the closest documented equivalent, not a value taken from the C source.
   */
  quality?: number;
  verbose?: boolean;
  onLog?: Logger;
}

export interface PrintLayoutCodecs {
  jpeg: JpegCodec;
  resize: ResizeCodec;
}

export async function printLayout(
  input: Uint8Array,
  codecs: PrintLayoutCodecs,
  options: PrintLayoutOptions = {},
): Promise<Uint8Array> {
  const TOOL = 'printLayout';
  const log =
    options.onLog ?? (options.verbose ? (m: string) => console.error(`[printLayout] ${m}`) : silentLogger);

  const wCm = options.widthCm ?? 0;
  const hCm = options.heightCm ?? 0;
  const tCm = options.topCm ?? 0;
  const useL = options.leftCm !== undefined;
  const useR = options.rightCm !== undefined;
  const lCm = options.leftCm ?? 0;
  const rCm = options.rightCm ?? 0;
  const center = options.center ?? false;

  // ── Validate all arguments before decoding anything (§3 of the guidelines
  // this suite follows — same order as xprint.c). ──────────────────────────
  if (wCm < 0 || hCm < 0 || tCm < 0 || lCm < 0 || rCm < 0) {
    throw new VaultError(TOOL, 'ARGS', 'dimension arguments must be non-negative');
  }
  if (wCm > 0 && hCm > 0) {
    throw new VaultError(TOOL, 'ARGS', 'widthCm and heightCm are mutually exclusive');
  }
  if (center && (useL || useR)) {
    throw new VaultError(TOOL, 'ARGS', 'center conflicts with leftCm / rightCm');
  }
  if (useL && useR) {
    throw new VaultError(TOOL, 'ARGS', 'leftCm and rightCm cannot both be specified');
  }
  // convertFormat and pdfToImages both validate `quality` the same way; printLayout didn't,
  // so a caller-supplied NaN/negative/500 silently reached the codec
  // instead of failing fast with a clear ARGS error like its siblings do.
  const quality = options.quality ?? 92;
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    throw new VaultError(TOOL, 'ARGS', 'quality must be between 1 and 100');
  }

  if (log !== silentLogger) log(`info: decoding input (${input.byteLength} bytes)`);
  const decoded = await codecs.jpeg.decode(toArrayBuffer(input));

  const pxPerCm = TARGET_DPI / 2.54;
  const ow = decoded.width;
  const oh = decoded.height;
  if (!ow || !oh) {
    throw new VaultError(TOOL, 'FORMAT', 'decoded image has zero width or height');
  }
  const aspect = ow / oh;

  let tw: number;
  let th: number;
  if (wCm > 0) {
    tw = Math.round(wCm * pxPerCm);
    th = Math.round(tw / aspect);
  } else if (hCm > 0) {
    th = Math.round(hCm * pxPerCm);
    tw = Math.round(th * aspect);
  } else {
    tw = ow;
    th = oh;
  }

  // A caller-supplied widthCm/heightCm small enough to round to 0px isn't
  // "resize to nothing," it's a request that can't be satisfied — without
  // this check it silently produced a correctly-sized blank A4 canvas with
  // an invisible 0-width image composited nowhere onto it (compositeOver's
  // loop bounds degrade to a no-op for a 0-width source, so nothing ever
  // signaled the problem).
  if (tw < 1 || th < 1) {
    throw new VaultError(
      TOOL,
      'ARGS',
      `requested size (${tw}x${th}px) is too small to produce any output pixels`,
    );
  }

  let resized: ImageData;
  if (tw === ow && th === oh) {
    // Identity resize — skip the WASM round trip entirely rather than
    // asking the resizer to reproduce a no-op (xprint.c always called
    // MagickResizeImage here too, but a same-size Lanczos resize is a
    // no-op on the pixels that matters for this port's purposes).
    resized = decoded;
  } else {
    log(`info: resizing image to ${tw}x${th} px`);
    resized = await codecs.resize.resize(decoded, { width: tw, height: th, method: 'lanczos3' });
  }

  // ── Build the white A4 canvas ────────────────────────────────────────────
  const cw = Math.round(A4_WIDTH_CM * pxPerCm);
  const ch = Math.round(A4_HEIGHT_CM * pxPerCm);
  const canvas = makeImageData(cw, ch, [255, 255, 255, 255]);

  // ── Compute placement offsets (identical branching to xprint.c) ────────
  const offY = Math.round(tCm * pxPerCm);
  let offX: number;
  if (center) {
    offX = Math.round((cw - tw) / 2);
  } else if (useL) {
    offX = Math.round(lCm * pxPerCm);
  } else if (useR) {
    offX = cw - tw - Math.round(rCm * pxPerCm);
  } else {
    offX = 0;
  }

  compositeOver(canvas, resized, offX, offY);

  log(`info: encoding ${cw}x${ch} canvas as JPEG (quality ${quality})`);
  const encoded = await codecs.jpeg.encode(canvas, { quality });
  return new Uint8Array(encoded);
}

/**
 * Plain pixel-buffer "over" compositing: copy `src` into `dst` at
 * (offsetX, offsetY), alpha-blending per pixel and clipping to `dst`'s
 * bounds. This is the manual loop migration_v1.md §3.1 and migration_v3.md
 * both describe as "no library needed for this step, it's just array
 * indexing" — never a WASM or third-party candidate.
 */
function compositeOver(dst: ImageData, src: ImageData, offsetX: number, offsetY: number): void {
  const srcX0 = Math.max(0, -offsetX);
  const srcY0 = Math.max(0, -offsetY);
  const srcX1 = Math.min(src.width, dst.width - offsetX);
  const srcY1 = Math.min(src.height, dst.height - offsetY);

  for (let sy = srcY0; sy < srcY1; sy++) {
    const dy = offsetY + sy;
    for (let sx = srcX0; sx < srcX1; sx++) {
      const dx = offsetX + sx;
      const sIdx = (sy * src.width + sx) * 4;
      const dIdx = (dy * dst.width + dx) * 4;

      const sa = src.data[sIdx + 3]! / 255;
      if (sa >= 1) {
        dst.data[dIdx] = src.data[sIdx]!;
        dst.data[dIdx + 1] = src.data[sIdx + 1]!;
        dst.data[dIdx + 2] = src.data[sIdx + 2]!;
        dst.data[dIdx + 3] = 255;
      } else if (sa > 0) {
        const da = 1 - sa;
        dst.data[dIdx] = Math.round(src.data[sIdx]! * sa + dst.data[dIdx]! * da);
        dst.data[dIdx + 1] = Math.round(src.data[sIdx + 1]! * sa + dst.data[dIdx + 1]! * da);
        dst.data[dIdx + 2] = Math.round(src.data[sIdx + 2]! * sa + dst.data[dIdx + 2]! * da);
        dst.data[dIdx + 3] = 255;
      }
      // sa === 0: fully transparent source pixel, leave dst untouched.
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
