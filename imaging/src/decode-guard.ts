/**
 * Pre-decode dimension guard for JPEG/PNG/WebP.
 *
 * BMP and TGA read width/height straight out of a fixed-offset header
 * field, so convert/bmp.ts and convert/tga.ts could call
 * assertSaneImageDimensions() before touching pixel data. PDF pages get
 * the same treatment in pdfToImages.ts via a declared-size clamp on the
 * MediaBox. JPEG/PNG/WebP never got the equivalent: they go straight into
 * `codecs.jpeg.decode()` / `.png.decode()` / `.webp.decode()`, which is a
 * jSquash call into WASM that allocates the full decoded RGBA buffer (and,
 * internally, its own intermediate buffers) before this library ever sees
 * a width or height to check. A crafted or merely huge JPEG/PNG/WebP can
 * therefore force that allocation with no chance for this library to
 * refuse first — exactly the decompression-bomb shape limits.ts's own doc
 * comment describes for BMP/TGA/PDF, just reached through a different
 * codec.
 *
 * The fix is the same shape as those other three: read the declared
 * dimensions out of the container header — a few dozen bytes, no decode
 * needed for any of the three formats — and run them through
 * assertSaneImageDimensions() before calling into the WASM decoder at all.
 * Header parsing failing (truncated/corrupt/unrecognized-variant input)
 * is deliberately *not* treated as a size violation: it's left to fall
 * through to the real decode, which will reject it on its own terms (or,
 * for a format variant this doesn't parse, succeed on an input that was
 * always going to be fine size-wise, since this guard is purely additive
 * and never the sole gate on validity).
 */

import { assertSaneImageDimensions } from './limits.js';

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function readU16BE(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function readU16LE(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function readU24LE(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

/** IHDR is always the first chunk, always 8 (sig) + 4 (len) + 4 ("IHDR") bytes in. */
function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = b[offset + 1]!;
    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 all carry height/width
    // at the same offset within the segment; skip markers with no length
    // (standalone) and other markers' payloads without inspecting them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const segLen = readU16BE(b, offset + 2);
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSOF) {
      if (offset + 9 > b.length) return null;
      return { height: readU16BE(b, offset + 5), width: readU16BE(b, offset + 7) };
    }
    if (marker === 0xda) return null; // start of scan — no SOF found before pixel data
    offset += 2 + segLen;
  }
  return null;
}

function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  return { width: readU32BE(b, 16), height: readU32BE(b, 20) };
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null;
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null;
  const fourCc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourCc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: readU16LE(b, 26) & 0x3fff, height: readU16LE(b, 28) & 0x3fff };
  }
  if (fourCc === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourCc === 'VP8X') {
    return { width: readU24LE(b, 24) + 1, height: readU24LE(b, 27) + 1 };
  }
  return null;
}

/**
 * Checks a JPEG/PNG/WebP's *declared* dimensions against the same bounds
 * BMP/TGA/PDF already enforce, before the caller hands `bytes` to a real
 * decode. No-op (doesn't throw) if the header doesn't parse cleanly —
 * that's left for the real decoder to reject on its own terms.
 */
export function assertDecodableImageSize(tool: string, bytes: Uint8Array, format: 'jpg' | 'png' | 'webp'): void {
  const dims =
    format === 'jpg' ? jpegDimensions(bytes) : format === 'png' ? pngDimensions(bytes) : webpDimensions(bytes);
  if (!dims) return;
  assertSaneImageDimensions(tool, dims.width, dims.height, format);
}
