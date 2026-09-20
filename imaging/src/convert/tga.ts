/**
 * TGA, like BMP, is header-plus-raw-bytes with no lossy step — same
 * "plain TypeScript is exactly as deterministic as a codec would be, for
 * zero weight" reasoning as bmp.ts. See that file's header comment for the
 * full rationale; not repeated here.
 *
 * Writer produces an uncompressed (image type 2), 32-bit BGRA TGA with the
 * top-left-origin descriptor bit set, so rows are stored top-down and no
 * vertical flip bookkeeping is needed on either side of the round trip.
 *
 * Reader accepts uncompressed true-color (image type 2) at 24 or 32 bits
 * per pixel, honoring the origin bit so it also reads TGAs written by other
 * encoders that default to bottom-left origin.
 */

import { VaultError } from '../errors.js';
import { makeImageData } from '../image-data.js';
import { assertSaneImageDimensions } from '../limits.js';

const TOOL = 'convertFormat';

const IMAGE_TYPE_UNCOMPRESSED_TRUECOLOR = 2;
const ORIGIN_TOP_LEFT_BIT = 0x20;

export function encodeTga(image: ImageData): Uint8Array {
  const { width, height, data } = image;
  const header = new Uint8Array(18);
  header[2] = IMAGE_TYPE_UNCOMPRESSED_TRUECOLOR;
  // width/height are little-endian uint16
  header[12] = width & 0xff;
  header[13] = (width >> 8) & 0xff;
  header[14] = height & 0xff;
  header[15] = (height >> 8) & 0xff;
  header[16] = 32; // bits per pixel
  header[17] = 0x08 | ORIGIN_TOP_LEFT_BIT; // 8 bits of alpha, top-left origin

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const sIdx = i * 4;
    const dIdx = i * 4;
    pixels[dIdx] = data[sIdx + 2]!; // B
    pixels[dIdx + 1] = data[sIdx + 1]!; // G
    pixels[dIdx + 2] = data[sIdx]!; // R
    pixels[dIdx + 3] = data[sIdx + 3]!; // A
  }

  const out = new Uint8Array(header.length + pixels.length);
  out.set(header, 0);
  out.set(pixels, header.length);
  return out;
}

export function decodeTga(bytes: Uint8Array): ImageData {
  if (bytes.length < 18) {
    throw new VaultError(TOOL, 'FORMAT', 'not a valid tga file (too short)');
  }
  const idLength = bytes[0]!;
  const colorMapType = bytes[1]!;
  const imageType = bytes[2]!;
  if (colorMapType !== 0) {
    throw new VaultError(TOOL, 'FORMAT', 'color-mapped tga not supported');
  }
  if (imageType !== IMAGE_TYPE_UNCOMPRESSED_TRUECOLOR) {
    throw new VaultError(
      TOOL,
      'FORMAT',
      `unsupported tga image type ${imageType} (only uncompressed truecolor is supported)`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bpp = bytes[16]!;
  const descriptor = bytes[17]!;
  const topDown = (descriptor & ORIGIN_TOP_LEFT_BIT) !== 0;

  if (bpp !== 24 && bpp !== 32) {
    throw new VaultError(TOOL, 'FORMAT', `unsupported tga bit depth ${bpp} (only 24/32 supported)`);
  }

  const bytesPerPixel = bpp / 8;
  const pixelDataStart = 18 + idLength;
  const rowSize = width * bytesPerPixel;

  // width/height are only uint16 (max 65535 each), so this can't overflow
  // JS numbers, but 65535x65535 is still a ~17GB RGBA allocation from an
  // 18-byte header — reject before allocating, same reasoning as bmp.ts.
  assertSaneImageDimensions(TOOL, width, height, 'tga');

  if (pixelDataStart + rowSize * height > bytes.length) {
    throw new VaultError(
      TOOL,
      'FORMAT',
      `truncated tga: header declares ${width}x${height} at ${bpp}bpp (needs ` +
        `${rowSize * height} bytes of pixel data from offset ${pixelDataStart}), but the file is only ` +
        `${bytes.length} bytes`,
    );
  }

  const out = makeImageData(width, height);
  for (let row = 0; row < height; row++) {
    const destY = topDown ? row : height - 1 - row;
    const rowStart = pixelDataStart + row * rowSize;
    for (let x = 0; x < width; x++) {
      const sIdx = rowStart + x * bytesPerPixel;
      const dIdx = (destY * width + x) * 4;
      out.data[dIdx] = bytes[sIdx + 2]!; // R
      out.data[dIdx + 1] = bytes[sIdx + 1]!; // G
      out.data[dIdx + 2] = bytes[sIdx]!; // B
      out.data[dIdx + 3] = bpp === 32 ? bytes[sIdx + 3]! : 255;
    }
  }
  return out;
}
