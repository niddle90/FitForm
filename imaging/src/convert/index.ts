/**
 * convertFormat — convert between image formats (JPG, PNG, BMP, TGA, WebP).
 * Browser port of xconv.c.
 *
 * Per migration_v3.md §2.2:
 *  - BMP / TGA: plain TypeScript (bmp.ts / tga.ts) — unconditional, never
 *    reconsidered, since there's no codec step to weigh WASM against.
 *  - WebP: `@jsquash/webp`, unconditional, HARD EXCLUDED from ever going
 *    native — Safari's `canvas.toBlob(cb, 'image/webp')` has been observed
 *    to silently return a mislabeled PNG instead of failing when WebP
 *    isn't supported. That's a correctness defect, not a consistency
 *    gradient, so no perceptual-delta measurement can rescue native here.
 *  - JPEG / PNG: `@jsquash/jpeg` / `@jsquash/png`, kept as the *default*
 *    pending measurement (migration_v3.md §2.2 marks this "OPEN", not
 *    "resolved native") — there's no size target in xconv.c, so only the
 *    perceptual floor in migration_v3.md §1 applies, and it hasn't been
 *    run against these exact code paths yet.
 */

import type { JpegCodec, PngCodec, WebpCodec } from '../codecs.js';
import { VaultError, silentLogger, type Logger } from '../errors.js';
import { assertDecodableImageSize } from '../decode-guard.js';
import { encodeBmp, decodeBmp } from './bmp.js';
import { encodeTga, decodeTga } from './tga.js';

export type ImageFormat = 'jpg' | 'png' | 'bmp' | 'tga' | 'webp';

export interface ConvertCodecs {
  jpeg: JpegCodec;
  /** Required only if PNG is involved as input or output format. */
  png?: PngCodec;
  /** Required only if WebP is involved as input or output format. */
  webp?: WebpCodec;
}

export interface ConvertOptions {
  /** Output format. Required if `outputFilename` doesn't carry a recognized extension. */
  format?: string;
  /** Used to infer the output format from its extension when `format` isn't given. */
  outputFilename?: string;
  /** JPEG/WebP quality, 1-100. Default 90 (matches xconv.c's default). */
  quality?: number;
  verbose?: boolean;
  onLog?: Logger;
}

export function formatFromString(s: string | undefined): ImageFormat | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'jpg' || lower === 'jpeg') return 'jpg';
  if (lower === 'png') return 'png';
  if (lower === 'bmp') return 'bmp';
  if (lower === 'tga') return 'tga';
  if (lower === 'webp') return 'webp';
  return null;
}

export function formatFromPath(path: string | undefined): ImageFormat | null {
  if (!path) return null;
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return formatFromString(path.slice(dot + 1));
}

/**
 * Sniffs the input format from magic bytes. TGA has no magic number (same
 * gap stb_image itself has), so it's only ever the fallback once every
 * signature-bearing format has been ruled out — matching the original
 * decoder's own effective priority order.
 */
export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  // No signature matched a known format. TGA has no magic number of its
  // own, so it can't be ruled *in* the way JPEG/PNG/BMP/WebP just were —
  // but unconditionally guessing 'tga' here means literally any other
  // unrecognized input (random bytes, a truncated download, a ZIP, a
  // text file) also gets called 'tga', which then flows into inspect()
  // and reports plausible-looking width/height read out of whatever
  // those random bytes happen to contain at the offsets a TGA header
  // would use. Only take the TGA branch when the bytes also pass a
  // structural check for the one TGA variant this library actually
  // supports (see looksLikeTga) — everything else reports as
  // unrecognized instead of a false-positive format guess.
  return looksLikeTga(bytes) ? 'tga' : null;
}

/**
 * Best-effort structural validation for the no-magic-number TGA format.
 * Deliberately scoped to exactly what decodeTga()/encodeTga() support
 * (uncompressed truecolor, no color map, 24 or 32 bits per pixel) rather
 * than the full TGA spec — a byte sequence that doesn't even look like
 * one of *those* certainly isn't a TGA this app can do anything with,
 * and validating against the full spec (RLE types, color-mapped types,
 * grayscale types, ...) would just accept more inputs this app would
 * then fail to decode anyway. This can still misidentify a plausible
 * 18-byte prefix of unrelated binary data as TGA — nothing can fully
 * rule TGA out without a magic number — but it's no longer "every
 * unrecognized file is a TGA".
 */
function looksLikeTga(bytes: Uint8Array): boolean {
  if (bytes.length < 18) return false;
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const width = bytes[12]! | (bytes[13]! << 8);
  const height = bytes[14]! | (bytes[15]! << 8);
  const pixelDepth = bytes[16];

  const IMAGE_TYPE_UNCOMPRESSED_TRUECOLOR = 2;
  if (colorMapType !== 0) return false;
  if (imageType !== IMAGE_TYPE_UNCOMPRESSED_TRUECOLOR) return false;
  if (width === 0 || height === 0) return false;
  if (pixelDepth !== 24 && pixelDepth !== 32) return false;

  return true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export async function convertFormat(
  input: Uint8Array,
  codecs: ConvertCodecs,
  options: ConvertOptions = {},
): Promise<Uint8Array> {
  const TOOL = 'convertFormat';
  const log =
    options.onLog ?? (options.verbose ? (m: string) => console.error(`[convertFormat] ${m}`) : silentLogger);

  const quality = options.quality ?? 90;
  if (quality < 1 || quality > 100) {
    throw new VaultError(TOOL, 'ARGS', 'quality must be between 1 and 100');
  }

  const outFormat = formatFromString(options.format) ?? formatFromPath(options.outputFilename);
  if (!outFormat) {
    throw new VaultError(
      TOOL,
      'ARGS',
      options.outputFilename
        ? `cannot infer output format from '${options.outputFilename}'; pass format explicitly`
        : 'format is required',
    );
  }

  const inFormat = detectFormat(input);
  log(`info: loading input (${input.byteLength} bytes)`);

  // BMP/TGA already check their declared dimensions before touching pixel
  // data (see assertSaneImageDimensions calls in bmp.ts/tga.ts). JPEG/PNG/
  // WebP go straight into a WASM decode below, which allocates the full
  // RGBA buffer (and its own intermediates) before this library gets a
  // width/height back to check — same unbounded-allocation shape, just
  // reached through a different codec. Check the declared size from the
  // header first, same bounds, before calling into the decoder.
  if (inFormat === 'jpg' || inFormat === 'png' || inFormat === 'webp') {
    assertDecodableImageSize(TOOL, input, inFormat);
  }

  let image: ImageData;
  switch (inFormat) {
    case 'jpg':
      image = await codecs.jpeg.decode(toArrayBuffer(input));
      break;
    case 'png':
      if (!codecs.png) throw new VaultError(TOOL, 'ARGS', 'png codec not configured');
      image = await codecs.png.decode(toArrayBuffer(input));
      break;
    case 'webp':
      if (!codecs.webp) throw new VaultError(TOOL, 'ARGS', 'webp codec not configured');
      image = await codecs.webp.decode(toArrayBuffer(input));
      break;
    case 'bmp':
      image = decodeBmp(input);
      break;
    case 'tga':
      image = decodeTga(input);
      break;
    default:
      throw new VaultError(TOOL, 'FORMAT', 'cannot decode input image');
  }

  log(`info: loaded ${image.width}x${image.height} image, converting to ${outFormat}`);

  let encoded: Uint8Array;
  switch (outFormat) {
    case 'jpg':
      encoded = new Uint8Array(await codecs.jpeg.encode(image, { quality }));
      break;
    case 'png':
      if (!codecs.png) throw new VaultError(TOOL, 'ARGS', 'png codec not configured');
      encoded = new Uint8Array(await codecs.png.encode(image));
      break;
    case 'webp':
      if (!codecs.webp) throw new VaultError(TOOL, 'ARGS', 'webp codec not configured');
      encoded = new Uint8Array(await codecs.webp.encode(image, { quality }));
      break;
    case 'bmp':
      encoded = encodeBmp(image);
      break;
    case 'tga':
      encoded = encodeTga(image);
      break;
  }

  log(`info: wrote ${encoded.length} bytes as ${outFormat}`);
  return encoded;
}
