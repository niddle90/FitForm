/**
 * Node implementation of compress.ts's CanvasProvider, backed by
 * @napi-rs/canvas (prebuilt native bindings, no compile step required).
 * Only needed if you use `compress` (the target-file-size compressor) from
 * Node -- convert/pdfToImages/jpegsToPdf/printLayout don't need a canvas at all, which
 * is why @napi-rs/canvas is an *optional* peer dependency (see
 * package.json's peerDependenciesMeta), not a hard one.
 *
 * In the browser, use `browserCanvasProvider` from 'imaging' (the
 * package root) instead -- that one has zero dependencies, using
 * OffscreenCanvas directly.
 */

import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import type { CanvasProvider, DecodedBitmap } from './compress.js';

interface NodeBitmap extends DecodedBitmap {
  image: Image;
}

export const nodeCanvasProvider: CanvasProvider = {
  async decodeToBitmap(bytes: Uint8Array): Promise<NodeBitmap> {
    const image = await loadImage(Buffer.from(bytes));
    return { width: image.width, height: image.height, image };
  },
  async renderJpeg(bitmap, width, height, quality) {
    const { image } = bitmap as NodeBitmap;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    // @napi-rs/canvas's encode() quality is 0-100, not 0-1 like the DOM's
    // canvas.convertToBlob — convert here, at the boundary, so compress.ts
    // itself stays written against the real browser convention.
    const buf = await canvas.encode('jpeg', Math.round(quality * 100));
    return new Uint8Array(buf);
  },
};
