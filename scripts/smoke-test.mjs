// Functional smoke test for every vault-suite call made in
// src/engine/worker.ts. Runs against the Node codec variant (the browser
// variant needs OffscreenCanvas/fetch-from-URL, which don't exist in
// plain Node) but exercises the *exact same* vxpress/vxconv/vxpeel/vxbind/
// resize/parseJpegMeta call shapes and option names used in the real
// worker, against the same pinned WASM binaries the app ships.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { vxpress, vxprint, vxconv, vxpeel, vxbind, parseJpegMeta, detectFormat } from 'vault-suite';
import { createNodeCodecs, createJpegOptEngineNode } from 'vault-suite/node';
import { initHqx, initMagicKernel } from '@jsquash/resize';

const require = createRequire(import.meta.url);
const ok = (label) => console.log(`  ✓ ${label}`);
const section = (label) => console.log(`\n${label}`);

section('boot: loading codecs + jpegopt + extra resize kernels');
const codecs = await createNodeCodecs();
const wasmEngine = await createJpegOptEngineNode();
await initHqx(readFileSync(require.resolve('@jsquash/resize/lib/hqx/pkg/squooshhqx_bg.wasm')));
await initMagicKernel(readFileSync(require.resolve('@jsquash/resize/lib/magic-kernel/pkg/jsquash_magic_kernel_bg.wasm')));
ok('all engines ready');

// ── synthesize a test image (gradient, no external assets needed) ──────
const W = 96, H = 64;
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    data[i] = Math.floor((x / W) * 255);
    data[i + 1] = Math.floor((y / H) * 255);
    data[i + 2] = 128;
    data[i + 3] = 255;
  }
}
const sourceImageData = { width: W, height: H, data, colorSpace: 'srgb' };

section('encode: source PNG + JPEG');
const pngBytes = new Uint8Array(await codecs.png.encode(sourceImageData));
assert.equal(detectFormat(pngBytes), 'png');
ok(`png encode: ${pngBytes.byteLength} bytes, detectFormat = png`);

const jpegBytes = new Uint8Array(await codecs.jpeg.encode(sourceImageData, { quality: 90 }));
assert.equal(detectFormat(jpegBytes), 'jpg');
const srcMeta = parseJpegMeta(jpegBytes);
assert.equal(srcMeta.w, W);
assert.equal(srcMeta.h, H);
ok(`jpeg encode: ${jpegBytes.byteLength} bytes, parseJpegMeta = ${srcMeta.w}x${srcMeta.h} ${srcMeta.cs}`);

section('resize: every documented method, exact target dims (stretch)');
for (const method of ['triangle', 'catrom', 'mitchell', 'lanczos3', 'hqx', 'magicKernel', 'magicKernelSharp2013', 'magicKernelSharp2021']) {
  const resized = await codecs.resize.resize(sourceImageData, { width: 48, height: 32, method });
  assert.equal(resized.width, 48);
  assert.equal(resized.height, 32);
  ok(`resize method=${method} -> 48x32`);
}

section('compress: vxpress wasm engine, target-size bisection');
const compressed = await vxpress(jpegBytes, {
  targetKb: 5,
  engine: 'wasm',
  wasmEngine,
  resolveWithObject: true,
  minQuality: 20,
  maxScaleTries: 5,
  subsampling: '4:2:0',
  progressive: false,
});
assert.ok(compressed.data.byteLength > 0);
assert.equal(detectFormat(compressed.data), 'jpg');
ok(`compressed to ${(compressed.data.byteLength / 1024).toFixed(2)}KB (target 5KB), engine=${compressed.engine}, quality=${compressed.quality}, metTarget=${compressed.metTarget}`);

section('compress: vxpress with forced cover-crop dimensions');
const croppedCompress = await vxpress(jpegBytes, {
  targetKb: 8,
  engine: 'wasm',
  wasmEngine,
  resolveWithObject: true,
  width: 40,
  height: 40,
  cropAnchor: 'center',
});
assert.equal(croppedCompress.width, 40);
assert.equal(croppedCompress.height, 40);
ok(`cover-crop compress -> ${croppedCompress.width}x${croppedCompress.height}`);

section('compress: pixel-level crop-anchor correctness (not just dimensions)');
// The dimensions-only check above (croppedCompress) would pass even if
// every anchor cropped from the same spot. This verifies the WASM
// engine's crop_anchored() actually keeps the requested edge of the
// image by building test images where each half is a flat, distinct
// color, cover-cropping them, and sampling real decoded pixels near
// both edges of the result.
function solidHalves(w, h, split, colorA, colorB, horizontal) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inA = horizontal ? x < split : y < split;
      const [r, g, b] = inA ? colorA : colorB;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, colorSpace: 'srgb' };
}
const GREEN = [0, 255, 0], YELLOW = [255, 255, 0], RED = [255, 0, 0], BLUE = [0, 0, 255];
function closeTo(actual, expected, tol = 40) {
  return Math.abs(actual[0] - expected[0]) <= tol && Math.abs(actual[1] - expected[1]) <= tol && Math.abs(actual[2] - expected[2]) <= tol;
}
async function cropAndSample(sourceImageData, cw, ch, anchor, sampleXs, sampleYs) {
  const src = new Uint8Array(await codecs.jpeg.encode(sourceImageData, { quality: 98 }));
  const out = await vxpress(src, {
    targetKb: 1_000_000, // effectively unbounded — isolates crop geometry from the size bisection
    engine: 'wasm',
    wasmEngine,
    resolveWithObject: true,
    width: cw,
    height: ch,
    cropAnchor: anchor,
    minQuality: 95,
    subsampling: '4:4:4',
  });
  assert.equal(out.width, cw);
  assert.equal(out.height, ch);
  const decoded = await codecs.jpeg.decode(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength));
  const pixel = (x, y) => {
    const i = (y * decoded.width + x) * 4;
    return [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]];
  };
  return sampleXs.map((x, idx) => pixel(x, sampleYs[idx]));
}

// Wide image: left half green, right half yellow. Source 200x100,
// requested crop 50x50 -> cover-scale 0.5 -> resized 100x50, so the
// color boundary lands at resized x=50 and the crop window (width 50)
// either sits entirely left of it, entirely right of it, or straddles
// it, depending on anchor.
const wideImg = solidHalves(200, 100, 100, GREEN, YELLOW, true);
{
  const [leftNear, leftFar] = await cropAndSample(wideImg, 50, 50, 'left', [5, 45], [25, 25]);
  assert.ok(closeTo(leftNear, GREEN), `left anchor near edge should be green, got ${leftNear}`);
  assert.ok(closeTo(leftFar, GREEN), `left anchor far edge should still be green (whole crop is left of the color boundary), got ${leftFar}`);
  ok('cropAnchor=left keeps the left (green) side across the whole crop width');

  const [rightNear, rightFar] = await cropAndSample(wideImg, 50, 50, 'right', [5, 45], [25, 25]);
  assert.ok(closeTo(rightNear, YELLOW), `right anchor near edge should be yellow, got ${rightNear}`);
  assert.ok(closeTo(rightFar, YELLOW), `right anchor far edge should still be yellow, got ${rightFar}`);
  ok('cropAnchor=right keeps the right (yellow) side across the whole crop width');

  const [centerLeft, centerRight] = await cropAndSample(wideImg, 50, 50, 'center', [5, 45], [25, 25]);
  assert.ok(closeTo(centerLeft, GREEN), `center anchor left edge should be green, got ${centerLeft}`);
  assert.ok(closeTo(centerRight, YELLOW), `center anchor right edge should be yellow, got ${centerRight}`);
  ok('cropAnchor=center straddles the boundary: green on the left edge, yellow on the right');
}

// Tall image: top half red, bottom half blue. Same geometry, rotated.
const tallImg = solidHalves(100, 200, 100, RED, BLUE, false);
{
  const [topNear, topFar] = await cropAndSample(tallImg, 50, 50, 'top', [25, 25], [5, 45]);
  assert.ok(closeTo(topNear, RED) && closeTo(topFar, RED), `top anchor should be red top-to-bottom, got ${topNear} / ${topFar}`);
  ok('cropAnchor=top keeps the top (red) side across the whole crop height');

  const [bottomNear, bottomFar] = await cropAndSample(tallImg, 50, 50, 'bottom', [25, 25], [5, 45]);
  assert.ok(closeTo(bottomNear, BLUE) && closeTo(bottomFar, BLUE), `bottom anchor should be blue top-to-bottom, got ${bottomNear} / ${bottomFar}`);
  ok('cropAnchor=bottom keeps the bottom (blue) side across the whole crop height');

  const [centerTop, centerBottom] = await cropAndSample(tallImg, 50, 50, 'center', [25, 25], [5, 45]);
  assert.ok(closeTo(centerTop, RED), `center anchor top edge should be red, got ${centerTop}`);
  assert.ok(closeTo(centerBottom, BLUE), `center anchor bottom edge should be blue, got ${centerBottom}`);
  ok('cropAnchor=center straddles the boundary: red on top, blue on bottom');
}

section('convert: round-trip through every output format');
for (const format of ['jpg', 'png', 'webp', 'bmp', 'tga']) {
  const out = await vxconv(pngBytes, codecs, { format, quality: 90 });
  assert.equal(detectFormat(out), format);
  ok(`png -> ${format}: ${out.byteLength} bytes, detectFormat confirms ${format}`);
}

section('print: vxprint A4 @ 300dpi layout');
const printed = await vxprint(jpegBytes, { jpeg: codecs.jpeg, resize: codecs.resize }, { topCm: 1, center: true, quality: 90 });
assert.equal(detectFormat(printed), 'jpg');
const printMeta = parseJpegMeta(printed);
const pxPerCm = 300 / 2.54;
assert.equal(printMeta.w, Math.round(21.0 * pxPerCm));
assert.equal(printMeta.h, Math.round(29.7 * pxPerCm));
ok(`print output ${printMeta.w}x${printMeta.h} matches computed A4@300dpi (2480x3508)`);

section('bind: wrap JPEG into a single-page PDF');
const { pdf } = vxbind([jpegBytes]);
assert.equal(String.fromCharCode(...pdf.slice(0, 4)), '%PDF');
ok(`vxbind produced a ${pdf.byteLength}-byte PDF starting with %PDF`);

section('pdf round trip: page count + vxpeel extraction on a hand-built minimal PDF');
function buildMinimalPdf() {
  const enc = (s) => new TextEncoder().encode(s);
  const parts = [];
  let offset = 0;
  const offsets = [0];
  const push = (str) => {
    const bytes = enc(str);
    parts.push(bytes);
    offset += bytes.byteLength;
  };
  push('%PDF-1.4\n');
  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = offset;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = offset;
  push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Resources << >> >>\nendobj\n');
  const xrefOffset = offset;
  push('xref\n0 4\n');
  push('0000000000 65535 f \n');
  for (let i = 1; i <= 3; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
const pdfBytes = buildMinimalPdf();

function pdfPageCount(bytes) {
  const pdfium = codecs.pdfium;
  const ptr = pdfium.heap.malloc(bytes.length);
  pdfium.heap.getHEAPU8().set(bytes, ptr);
  try {
    const doc = pdfium.FPDF_LoadMemDocument64(ptr, bytes.length, '');
    assert.ok(doc, `pdfium failed to parse the hand-built PDF (error ${pdfium.FPDF_GetLastError()})`);
    try {
      return pdfium.FPDF_GetPageCount(doc);
    } finally {
      pdfium.FPDF_CloseDocument(doc);
    }
  } finally {
    pdfium.heap.free(ptr);
  }
}
const pageCount = pdfPageCount(pdfBytes);
assert.equal(pageCount, 1);
ok(`hand-built PDF parses, page count = ${pageCount}`);

const pages = await vxpeel(pdfBytes, codecs, { page: 1, quality: 85, maxRenderDim: 400 });
assert.equal(pages.length, 1);
assert.equal(pages[0].pageNumber, 1);
assert.ok(pages[0].jpeg.byteLength > 0);
assert.equal(detectFormat(pages[0].jpeg), 'jpg');
const pageMeta = parseJpegMeta(pages[0].jpeg);
ok(`vxpeel extracted page 1 as JPEG: ${pages[0].jpeg.byteLength} bytes, ${pageMeta.w}x${pageMeta.h}`);

section('all checks passed');
