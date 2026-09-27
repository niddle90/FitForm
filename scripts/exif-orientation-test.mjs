// Unit tests for src/engine/exif-orientation.ts — the pixel-rotation
// helpers worker.ts applies right after JPEG decode so the rest of the
// pipeline (resize/crop/compress) operates on display-correct pixels
// instead of the raw, as-stored ones. Exists as its own dependency-free
// test file because worker.ts can't be imported directly outside a real
// Worker (it does `const ctx: any = self` at module scope), so this is
// the only place this specific transform gets exercised.
//
// Run with: node scripts/exif-orientation-test.mjs
// (Node 22+ strips the `import type` / type-annotation syntax in
// src/engine/exif-orientation.ts natively — no build step needed.)

import assert from 'node:assert/strict';

// exif-orientation.ts only touches `image.width`/`.height`/`.data` and
// constructs `new ImageData(data, w, h)` — a minimal same-shape polyfill
// is all a plain Node process needs to exercise it, no browser/worker
// environment required.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { orientedDimensions, applyExifOrientation } = await import('../src/engine/exif-orientation.ts');

const ok = (label) => console.log(`  ✓ ${label}`);
const section = (label) => console.log(`\n${label}`);

let failures = 0;
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
  }
}

// A 3-wide, 2-tall test image, one identifiable byte (0..5) per pixel in
// the red channel, laid out (row-major, top-to-bottom, left-to-right) as:
//   A B C
//   D E F
// This is the same matrix used to hand-derive the rotation formulas
// applyExifOrientation implements, so the expected outputs below are
// exactly the textbook 90°-rotation results for it.
function makeTestImage() {
  const [A, B, C, D, E, F] = [0, 1, 2, 3, 4, 5];
  const w = 3;
  const h = 2;
  const px = [A, B, C, D, E, F];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i++) {
    data[i * 4] = px[i];
    data[i * 4 + 1] = px[i];
    data[i * 4 + 2] = px[i];
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, w, h);
}

/** Reads back the red-channel "labels" of an ImageData as a row-major array, for easy comparison. */
function labels(image) {
  const out = [];
  for (let i = 0; i < image.width * image.height; i++) out.push(image.data[i * 4]);
  return out;
}

section('orientedDimensions:');

check('orientation 1 (default): dimensions unchanged', () => {
  assert.deepEqual(orientedDimensions(3, 2, 1), { width: 3, height: 2 });
});

check('orientation 3 (180°): dimensions unchanged', () => {
  assert.deepEqual(orientedDimensions(3, 2, 3), { width: 3, height: 2 });
});

check('orientation 6 (90° CW): dimensions swapped', () => {
  assert.deepEqual(orientedDimensions(3, 2, 6), { width: 2, height: 3 });
});

check('orientation 8 (90° CCW): dimensions swapped', () => {
  assert.deepEqual(orientedDimensions(3, 2, 8), { width: 2, height: 3 });
});

section('applyExifOrientation:');

check('orientation 1 (default): pixels and dimensions unchanged', () => {
  const img = makeTestImage();
  const out = applyExifOrientation(img, 1);
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual(labels(out), [0, 1, 2, 3, 4, 5]); // A B C / D E F
});

check('unhandled orientation (2, a mirror flip) passes through unchanged', () => {
  // Scope matches jpegsToPdf.ts's own switch: only 3/6/8 are corrected for.
  const img = makeTestImage();
  const out = applyExifOrientation(img, 2);
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual(labels(out), [0, 1, 2, 3, 4, 5]);
});

check('orientation 3 (180°): point-reflected, dimensions unchanged', () => {
  const img = makeTestImage();
  const out = applyExifOrientation(img, 3);
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  // A B C        F E D
  // D E F  -->   C B A
  assert.deepEqual(labels(out), [5, 4, 3, 2, 1, 0]);
});

check('orientation 6 (90° CW): rotated, dimensions swapped', () => {
  const img = makeTestImage();
  const out = applyExifOrientation(img, 6);
  assert.equal(out.width, 2); // swapped: was height
  assert.equal(out.height, 3); // swapped: was width
  // A B C        D A
  // D E F  -->   E B
  //              F C
  assert.deepEqual(labels(out), [3, 0, 4, 1, 5, 2]);
});

check('orientation 8 (90° CCW): rotated, dimensions swapped', () => {
  const img = makeTestImage();
  const out = applyExifOrientation(img, 8);
  assert.equal(out.width, 2);
  assert.equal(out.height, 3);
  // A B C        C F
  // D E F  -->   B E
  //              A D
  assert.deepEqual(labels(out), [2, 5, 1, 4, 0, 3]);
});

check('orientation 6 then 8 round-trips back to the original', () => {
  // A sanity check independent of the hand-derived expected matrices
  // above: rotating 90° CW then 90° CCW should be the identity transform.
  const img = makeTestImage();
  const rotated = applyExifOrientation(img, 6);
  const roundTripped = applyExifOrientation(rotated, 8);
  assert.equal(roundTripped.width, 3);
  assert.equal(roundTripped.height, 2);
  assert.deepEqual(labels(roundTripped), [0, 1, 2, 3, 4, 5]);
});

check('alpha channel survives rotation (not just the sampled red channel)', () => {
  const img = makeTestImage();
  img.data[3] = 128; // give pixel A a distinct, non-255 alpha
  const out = applyExifOrientation(img, 6);
  // Pixel A (label 0) lands at index 1 of the rotated output (see the
  // orientation-6 expected layout above: [3, 0, 4, 1, 5, 2]).
  assert.equal(out.data[1 * 4 + 3], 128);
});

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
