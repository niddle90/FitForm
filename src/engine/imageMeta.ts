import type { ImageFormat } from './types';

export interface BasicImageMeta {
  width: number;
  height: number;
}

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readI32LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}
function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

function parsePng(b: Uint8Array): BasicImageMeta | null {
  // 8-byte PNG signature, then the IHDR chunk is always first: 4-byte
  // length, "IHDR", then big-endian width/height (4 bytes each).
  if (b.length < 24) return null;
  return { width: readU32BE(b, 16), height: readU32BE(b, 20) };
}

function parseBmp(b: Uint8Array): BasicImageMeta | null {
  // 14-byte BITMAPFILEHEADER, then width/height sit at the same offset
  // (18/22) across every BITMAPINFOHEADER variant (40, 52, 56, 108, 124
  // bytes). Height can be negative for a top-down bitmap.
  if (b.length < 26) return null;
  return { width: Math.abs(readI32LE(b, 18)), height: Math.abs(readI32LE(b, 22)) };
}

function parseTga(b: Uint8Array): BasicImageMeta | null {
  // TGA has no magic number, so unlike the other parsers here this can't
  // lean on detectFormat() having already confirmed the signature — it
  // only confirmed detectFormat's own structural TGA check passed, and
  // this function is exported and can be called independently of that.
  // Re-check the same fields (full 18-byte header, uncompressed
  // truecolor, no color map, 24/32bpp) before trusting bytes 12-15 as
  // real dimensions, rather than reading them out of whatever a
  // non-TGA file happens to have at that offset.
  if (b.length < 18) return null;
  const colorMapType = b[1];
  const imageType = b[2];
  const pixelDepth = b[16];
  if (colorMapType !== 0 || imageType !== 2) return null;
  if (pixelDepth !== 24 && pixelDepth !== 32) return null;
  const width = readU16LE(b, 12);
  const height = readU16LE(b, 14);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function parseWebp(b: Uint8Array): BasicImageMeta | null {
  // RIFF container: "RIFF" + size + "WEBP", then one of three chunk
  // sub-formats, each encoding width/height differently.
  if (b.length < 30) return null;
  const fourCc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourCc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: readU16LE(b, 26) & 0x3fff, height: readU16LE(b, 28) & 0x3fff };
  }
  if (fourCc === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourCc === 'VP8X') {
    return { width: readU24LE(b, 24) + 1, height: readU24LE(b, 27) + 1 };
  }
  return null;
}

/**
 * Cheap header-only dimension readers for formats where the worker would
 * otherwise fully decode the image just to read width/height — for a
 * large photo that's a full RGBA allocation (a 6000x4000 image is
 * ~92 MB) spent on two numbers. JPEG already has imaging's
 * parseJpegMeta for the same purpose; this covers the rest.
 *
 * Returns null on anything that doesn't parse cleanly (truncated/corrupt
 * files, or a WebP animation/extended-format variant this doesn't cover)
 * — callers should fall back to a full decode in that case, same as
 * before this existed.
 */
export function parseHeaderDimensions(bytes: Uint8Array, format: ImageFormat): BasicImageMeta | null {
  try {
    switch (format) {
      case 'png':
        return parsePng(bytes);
      case 'bmp':
        return parseBmp(bytes);
      case 'tga':
        return parseTga(bytes);
      case 'webp':
        return parseWebp(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
