/**
 * Node implementation of compress.ts's CanvasProvider, backed by
 * @napi-rs/canvas (prebuilt native bindings, no compile step). This is
 * ONLY here so the smoke suite can exercise compress's real search
 * algorithm against real encoded byte sizes without a browser. Production
 * code uses `browserCanvasProvider` from `src/compress.ts`, which is the
 * actual zero-dependency shipping path per migration_v3.md §2.1.
 */

import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import type { CanvasProvider, DecodedBitmap } from '../src/compress.js';

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
