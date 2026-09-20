/**
 * BMP is an uncompressed raster format: fixed headers plus raw pixel bytes.
 * A plain reader/writer here is exactly as deterministic across engines as
 * a WASM codec would be, for zero weight — migration_v1.md §3.4 and
 * migration_v2.md §3.3 both make this same call for jpegsToPdf and for
 * BMP/TGA specifically. No `@jsquash/*` package covers BMP at all, so
 * this isn't a choice between native-vs-WASM; there is no codec here to
 * choose between.
 *
 * Writer produces 24-bit BGR, bottom-up, rows padded to a 4-byte boundary
 * — the common, widely-compatible BMP shape (matches what stb_image_write's
 * BMP writer produces: no alpha channel, since BMP's alpha support is
 * inconsistently implemented across readers).
 *
 * Reader accepts uncompressed (BI_RGB) 24-bit and 32-bit BMPs, both
 * top-down (negative height) and bottom-up (positive height) row order.
 */

import { VaultError } from '../errors.js';
import { makeImageData } from '../image-data.js';
import { assertSaneImageDimensions } from '../limits.js';

const TOOL = 'convertFormat';

export function encodeBmp(image: ImageData): Uint8Array {
  const { width, height, data } = image;
  const rowSize = Math.ceil((width * 3) / 4) * 4; // 24bpp rows padded to 4 bytes
  const pixelArraySize = rowSize * height;
  const fileHeaderSize = 14;
  const infoHeaderSize = 40;
  const pixelOffset = fileHeaderSize + infoHeaderSize;
  const fileSize = pixelOffset + pixelArraySize;

  const buf = new Uint8Array(fileSize);
  const view = new DataView(buf.buffer);

  // BITMAPFILEHEADER
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true); // reserved
  view.setUint32(10, pixelOffset, true);

  // BITMAPINFOHEADER
  view.setUint32(14, infoHeaderSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive => bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(30, 0, true); // BI_RGB, no compression
  view.setUint32(34, pixelArraySize, true);
  view.setInt32(38, 2835, true); // ~72 DPI, horizontal (not meaningful upstream)
  view.setInt32(42, 2835, true); // ~72 DPI, vertical
  view.setUint32(46, 0, true); // colors in palette
  view.setUint32(50, 0, true); // important colors

  for (let y = 0; y < height; y++) {
    // Bottom-up: first output row is the image's last row.
    const srcY = height - 1 - y;
    const rowStart = pixelOffset + y * rowSize;
    for (let x = 0; x < width; x++) {
      const sIdx = (srcY * width + x) * 4;
      const dIdx = rowStart + x * 3;
      buf[dIdx] = data[sIdx + 2]!; // B
      buf[dIdx + 1] = data[sIdx + 1]!; // G
      buf[dIdx + 2] = data[sIdx]!; // R
    }
    // Remaining bytes in the padded row are already zero-initialized.
  }

  return buf;
}

export function decodeBmp(bytes: Uint8Array): ImageData {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new VaultError(TOOL, 'FORMAT', 'not a valid bmp file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const pixelOffset = view.getUint32(10, true);
  const infoHeaderSize = view.getUint32(14, true);
  if (infoHeaderSize < 40) {
    throw new VaultError(TOOL, 'FORMAT', `unsupported bmp info header size ${infoHeaderSize}`);
  }
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (compression !== 0) {
    throw new VaultError(TOOL, 'FORMAT', `compressed bmp (compression=${compression}) not supported`);
  }
  if (bpp !== 24 && bpp !== 32) {
    throw new VaultError(TOOL, 'FORMAT', `unsupported bmp bit depth ${bpp} (only 24/32 supported)`);
  }

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;

  // width is a *signed* BITMAPINFOHEADER field per the spec (negative width
  // is invalid, not "meaningful the way negative height is"); this also
  // catches width === 0 and enforces a sane upper bound before allocating
  // anything, so a header lying about its dimensions fails cleanly instead
  // of throwing a raw RangeError (or actually attempting a multi-GB alloc).
  assertSaneImageDimensions(TOOL, width, height, 'bmp');

  if (pixelOffset + rowSize * height > bytes.length) {
    throw new VaultError(
      TOOL,
      'FORMAT',
      `truncated bmp: header declares ${width}x${height} at ${bpp}bpp (needs ` +
        `${rowSize * height} bytes of pixel data from offset ${pixelOffset}), but the file is only ` +
        `${bytes.length} bytes`,
    );
  }

  const out = makeImageData(width, height);
  for (let row = 0; row < height; row++) {
    const destY = topDown ? row : height - 1 - row;
    const rowStart = pixelOffset + row * rowSize;
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
