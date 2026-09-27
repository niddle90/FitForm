// ── EXIF orientation ─────────────────────────────────────────────────────
//
// jpegsToPdf.ts (in the imaging package) already corrects for EXIF
// orientation when wrapping a JPEG into a PDF (it rotates the PDF page via
// a content-stream matrix instead of touching pixels, since a PDF page can
// just declare a transform). The pixel-level pipeline in worker.ts (decode
// -> resize -> crop -> compress -> convert) had no equivalent: it decoded
// raw JPEG pixels and operated on them exactly as stored, ignoring any
// orientation tag — so a phone photo taken in portrait (which JPEG almost
// always stores as a landscape pixel grid plus a rotation tag) would get
// resized/cropped against the *stored* aspect ratio instead of the
// *displayed* one, and the final re-encoded JPEG carries no orientation
// tag at all (this pipeline's encoders don't write EXIF), so it would come
// out visibly rotated in every viewer.
//
// Fixing this at decode time — physically rotating the pixel buffer once,
// right after decode, before any other stage sees it — means every later
// stage just works on correctly-oriented pixels without needing to know
// orientation is a thing, and the final output needs no orientation tag
// because it's already right-side-up.
//
// Scope matches jpegsToPdf.ts's own `switch (m.orient)` exactly: only 3
// (180°), 6 (90° CW), and 8 (90° CCW) are handled — what an in-camera
// rotation sensor actually produces (phone held upside-down/sideways),
// covering the overwhelming majority of real-world orientation tags.
// Orientations 2/4/5/7 (mirror flips, effectively never produced by a
// camera) pass through unchanged, same as jpegsToPdf's `default` case.

/** For an EXIF-oriented image, the display-correct width/height (swapped for 6/8). */
export function orientedDimensions(w: number, h: number, orient: number): { width: number; height: number } {
  return orient === 6 || orient === 8 ? { width: h, height: w } : { width: w, height: h };
}

/** Physically rotates decoded pixels into display orientation for EXIF orientations 3/6/8; a no-op otherwise. */
export function applyExifOrientation(image: ImageData, orient: number): ImageData {
  if (orient !== 3 && orient !== 6 && orient !== 8) return image;
  const { width: w, height: h, data: src } = image;
  const { width: outW, height: outH } = orientedDimensions(w, h, orient);
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      let dx: number;
      let dy: number;
      if (orient === 3) {
        // 180°
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else if (orient === 6) {
        // 90° CW
        dx = h - 1 - y;
        dy = x;
      } else {
        // 8: 90° CCW
        dx = y;
        dy = w - 1 - x;
      }
      const di = (dy * outW + dx) * 4;
      dst[di] = src[si]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
  return new ImageData(dst, outW, outH);
}
