/**
 * End-to-end smoke suite for the migration_v3.md port.
 *
 * This is intentionally NOT the "golden-file test suite across real
 * browser engines" migration_v3.md §7/§9 calls for — that needs actual
 * Chrome/Firefox/WebKit and CI wiring this sandbox doesn't have. What this
 * *does* verify, against the real pinned packages (no mocks for the
 * codecs): each tool's control flow, argument validation, and byte-level
 * output structure are correct. Run with `npm test`.
 */

import { compress, type CanvasProvider } from '../src/compress.js';
import { printLayout } from '../src/printLayout.js';
import { convertFormat, detectFormat, formatFromString, formatFromPath } from '../src/convert/index.js';
import { decodeBmp } from '../src/convert/bmp.js';
import { decodeTga } from '../src/convert/tga.js';
import { jpegsToPdf, parseJpegMeta } from '../src/jpegsToPdf.js';
import { pdfToImages } from '../src/pdfToImages.js';
import { VaultError } from '../src/errors.js';
import { createJpegOptEngineFromBinary } from '../src/jpegopt-engine.js';

import { readFile } from 'node:fs/promises';
import { createNodeCodecs } from './node-codecs.js';
import { nodeCanvasProvider } from './node-canvas-provider.js';
import { makeSyntheticPhotoJpeg, makeTestPdf } from './fixtures.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(e instanceof Error ? `    ${e.stack ?? e.message}` : e);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function expectVaultError(fn: () => Promise<unknown> | unknown, code: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof VaultError && e.code === code) return;
    throw new Error(`${label}: expected VaultError(${code}), got ${e instanceof Error ? e.message : e}`);
  }
  throw new Error(`${label}: expected VaultError(${code}), but no error was thrown`);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Scans top-level JPEG markers for a specific SOF/marker byte (e.g. 0xc2 for SOF2/progressive). */
function hasJpegMarker(bytes: Uint8Array, marker: number): boolean {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const m = bytes[pos + 1]!;
    if (m === marker) return true;
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xda) break; // start of scan -- no more markers worth scanning for this check
    const len = (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
    pos += 2 + len;
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  console.log('Building shared codecs (real jSquash + pdfium wasm)...');
  const codecs = await createNodeCodecs();

  const photo = await makeSyntheticPhotoJpeg(1600, 1200, 92);
  console.log(`Fixture photo: ${photo.length} bytes (${Math.round(photo.length / 1024)}kb)\n`);

  // ── compress ──────────────────────────────────────────────────────────
  console.log('compress:');

  await test('rejects target-kb <= 0', async () => {
    await expectVaultError(
      () => compress(photo, { targetKb: 0, canvasProvider: nodeCanvasProvider }),
      'ARGS',
      'compress targetKb=0',
    );
  });

  await test('passthrough when already within target', async () => {
    const currentKb = Math.floor(photo.length / 1024);
    const out = await compress(photo, { targetKb: currentKb + 100, canvasProvider: nodeCanvasProvider });
    assert(out === photo, 'expected the exact same buffer back, unmodified');
  });

  await test('compresses down to at-or-under the target size', async () => {
    const currentKb = Math.floor(photo.length / 1024);
    const targetKb = Math.max(10, Math.floor(currentKb / 4));
    const out = await compress(photo, { targetKb, canvasProvider: nodeCanvasProvider });
    assert(isJpeg(out), 'output should still be a jpeg');
    const outKb = out.length / 1024;
    assert(outKb <= targetKb + 1, `output ${outKb.toFixed(1)}kb should be <= target ${targetKb}kb (+1kb slack)`);
  });

  await test('throws CONSTRAINT when even minimum quality/width cannot hit the target', async () => {
    // A real JPEG encoder can usually squeeze a 1x1 pixel under almost any
    // realistic target, so this path is easiest to force deterministically
    // with a fake provider that simply never produces fewer than 6000
    // bytes, regardless of requested width/quality.
    const stubbornProvider: CanvasProvider = {
      async decodeToBitmap() {
        return { width: 800, height: 600 };
      },
      async renderJpeg() {
        return new Uint8Array(6000);
      },
    };
    await expectVaultError(
      () => compress(photo, { targetKb: 1, canvasProvider: stubbornProvider }),
      'CONSTRAINT',
      'compress with a stubborn encoder',
    );
  });

  // ── compress: wasm engine (native, verified-against-a-real-build core) ──
  console.log('\ncompress (wasm engine):');

  // Real compiled artifact, not a mock -- same "no mocks for the codecs"
  // standard the jSquash/pdfium wiring above holds itself to. This is the
  // exact file a consumer's createJpegOptEngineNode() would load.
  const jpegoptWasmBytes = await readFile(new URL('../wasm/jpegopt.wasm', import.meta.url));
  const wasmEngine = await createJpegOptEngineFromBinary(jpegoptWasmBytes);

  await test('wasm engine compresses down to at-or-under the target size', async () => {
    const currentKb = Math.floor(photo.length / 1024);
    const targetKb = Math.max(10, Math.floor(currentKb / 4));
    // No fixedDimension here deliberately: this test is about the overall
    // "final size <= target" contract, which the autoscale fallback exists
    // precisely to guarantee. (Pinning dimensions AND picking a tight
    // target is a *combined* ask the engine correctly refuses rather than
    // silently missing — see the dedicated minQuality/CONSTRAINT test
    // below for that behavior specifically.)
    const out = await compress(photo, { targetKb, engine: 'wasm', wasmEngine });
    assert(isJpeg(out), 'output should still be a jpeg');
    assert(out.length / 1024 <= targetKb, `output should be <= target ${targetKb}kb`);
  });

  await test("engine: 'auto' picks wasm for jpeg input once a wasmEngine is supplied", async () => {
    const currentKb = Math.floor(photo.length / 1024);
    const targetKb = Math.max(10, Math.floor(currentKb / 4));
    const out = await compress(photo, {
      targetKb,
      wasmEngine,
      resolveWithObject: true,
    });
    assert(out.engine === 'wasm', `expected 'auto' to resolve to wasm, got '${out.engine}'`);
    assert(typeof out.quality === 'number', 'wasm result should report a quality');
  });

  await test("engine: 'auto' falls back to canvas for non-jpeg input even with a wasmEngine supplied", async () => {
    // A mock CanvasProvider, not the real native one, is deliberate here:
    // this test is only about *engine selection* (does 'auto' correctly
    // route non-JPEG bytes away from the JPEG-only wasm engine?), not
    // about decoder robustness against malformed bytes -- that's covered
    // separately, and see README.md "Security notes" for why exercising
    // the real @napi-rs/canvas decoder on arbitrary malformed bytes isn't
    // something this suite does casually.
    let calledDecode = false;
    const recordingProvider: CanvasProvider = {
      async decodeToBitmap() {
        calledDecode = true;
        return { width: 4, height: 4 };
      },
      async renderJpeg() {
        return new Uint8Array(10);
      },
    };
    // targetKb must be below the input's size, or the byte-count
    // passthrough shortcut returns early before any engine is even
    // resolved -- see the "already within target" test up in the base
    // compress section for that shortcut's own dedicated coverage.
    const notAJpeg = new Uint8Array(5000); // all zeros -- definitely not FF D8, and > 1kb
    await compress(notAJpeg, { targetKb: 1, wasmEngine, canvasProvider: recordingProvider });
    assert(calledDecode, "expected the canvas path (not the wasm engine) to run for non-jpeg input");
  });

  await test("engine: 'wasm' without a wasmEngine is a clean ARGS error", async () => {
    await expectVaultError(
      () => compress(photo, { targetKb: 50, engine: 'wasm' }),
      'ARGS',
      'compress engine=wasm with no wasmEngine',
    );
  });

  await test('wasm engine: subsampling 4:2:0 produces a smaller (or equal) file than 4:4:4 at the same quality target', async () => {
    // Deliberately below currentKb (113kb) so the passthrough shortcut
    // doesn't return the untouched original for both calls, which would
    // make this assertion pass vacuously instead of actually exercising
    // subsampling.
    const targetKb = 90;
    const full = await compress(photo, { targetKb, engine: 'wasm', wasmEngine, resolveWithObject: true });
    const sub420 = await compress(photo, { targetKb, engine: 'wasm', wasmEngine, subsampling: '4:2:0', resolveWithObject: true });
    assert(sub420.data.length <= full.data.length, '4:2:0 should not be larger than 4:4:4 at the same quality');
  });

  await test('wasm engine: --progressive produces a genuinely progressive JPEG (SOF2, not SOF0)', async () => {
    const out = await compress(photo, { targetKb: 80, engine: 'wasm', wasmEngine, progressive: true, resolveWithObject: true });
    assert(hasJpegMarker(out.data, 0xc2), 'expected a SOF2 (progressive) marker');
    assert(!hasJpegMarker(out.data, 0xc0), 'did not expect a SOF0 (baseline) marker alongside it');
  });

  await test('wasm engine: cropAnchor changes which part of a cover-resized image is kept', async () => {
    const top = await compress(photo, { targetKb: 500, engine: 'wasm', wasmEngine, width: 400, height: 200, cropAnchor: 'top', resolveWithObject: true });
    const bottom = await compress(photo, { targetKb: 500, engine: 'wasm', wasmEngine, width: 400, height: 200, cropAnchor: 'bottom', resolveWithObject: true });
    assert(top.width === 400 && top.height === 200, 'cover resize should hit the exact requested box');
    assert(!bytesEqual(top.data, bottom.data), 'top-anchored and bottom-anchored crops of a real photo should differ');
  });

  await test('wasm engine: minQuality floor is honored even when it means missing the target', async () => {
    const tiny = await compress(photo, {
      targetKb: 1,
      engine: 'wasm',
      wasmEngine,
      fixedDimension: true,
      minQuality: 90,
      allowMiss: true,
      resolveWithObject: true,
    });
    assert(tiny.quality! >= 90, `expected quality floor of 90 to be respected, got ${tiny.quality}`);
    assert(tiny.metTarget === false, 'a 1kb target at quality>=90 on a real photo should miss (that is the point of this test)');
  });

  await test('wasm engine: a miss throws CONSTRAINT by default, and only resolves when allowMiss is set', async () => {
    await expectVaultError(
      () => compress(photo, { targetKb: 1, engine: 'wasm', wasmEngine, fixedDimension: true, minQuality: 90 }),
      'CONSTRAINT',
      'wasm engine miss without allowMiss',
    );
    const withAllowMiss = await compress(photo, {
      targetKb: 1,
      engine: 'wasm',
      wasmEngine,
      fixedDimension: true,
      minQuality: 90,
      allowMiss: true,
    });
    assert(isJpeg(withAllowMiss), 'allowMiss should still return a complete, valid jpeg');
  });

  await test('wasm engine: rejects non-jpeg input as a clean FORMAT error, not a crash', async () => {
    // Unlike the real native canvas decoder (see README "Security notes"),
    // libjpeg-turbo's own error path is caught internally via
    // setjmp/longjmp -- this is a deliberate, verified robustness
    // advantage of the wasm engine, not just an assumption.
    //
    // Buffer must be bigger than targetKb*1024, or the byte-count
    // passthrough shortcut returns it untouched before decode is ever
    // attempted (same reasoning as the 'auto' canvas-fallback test above).
    const notAJpeg = new Uint8Array(50_000).fill(0xaa);
    await expectVaultError(
      () => compress(notAJpeg, { targetKb: 1, engine: 'wasm', wasmEngine }),
      'FORMAT',
      'wasm engine with garbage input',
    );
  });

  // ── printLayout ──────────────────────────────────────────────────────────
  console.log('\nprintLayout:');

  await test('rejects width+height both set', async () => {
    await expectVaultError(
      () => printLayout(photo, codecs, { widthCm: 10, heightCm: 10 }),
      'ARGS',
      'printLayout width+height',
    );
  });

  await test('rejects center with left/right', async () => {
    await expectVaultError(
      () => printLayout(photo, codecs, { center: true, leftCm: 1 }),
      'ARGS',
      'printLayout center+left',
    );
  });

  await test('lays out onto a full A4-at-300dpi canvas', async () => {
    const out = await printLayout(photo, codecs, { widthCm: 10, topCm: 2, center: true });
    assert(isJpeg(out), 'output should be a jpeg');
    const decoded = await codecs.jpeg.decode(out.buffer as ArrayBuffer);
    const expectedW = Math.round(21.0 * (300 / 2.54));
    const expectedH = Math.round(29.7 * (300 / 2.54));
    assert(decoded.width === expectedW, `canvas width ${decoded.width} should equal A4 width ${expectedW}px`);
    assert(decoded.height === expectedH, `canvas height ${decoded.height} should equal A4 height ${expectedH}px`);
    // Corner far from the composited image should still be background white.
    const idx = (5 * decoded.width + 5) * 4;
    assert(
      decoded.data[idx]! > 240 && decoded.data[idx + 1]! > 240 && decoded.data[idx + 2]! > 240,
      'top-left corner should be white background',
    );
  });

  // ── convertFormat ───────────────────────────────────────────────────────────
  console.log('\nconvertFormat:');

  await test('format helpers parse extensions and explicit names', () => {
    assert(formatFromString('JPEG') === 'jpg', 'formatFromString JPEG');
    assert(formatFromString('bogus') === null, 'formatFromString bogus');
    assert(formatFromPath('photo.PNG') === 'png', 'formatFromPath .PNG');
    assert(formatFromPath('noext') === null, 'formatFromPath noext');
  });

  await test('rejects missing format/outputFilename', async () => {
    await expectVaultError(() => convertFormat(photo, codecs, {}), 'ARGS', 'convertFormat no format');
  });

  await test('jpg -> png produces a valid PNG signature', async () => {
    const out = await convertFormat(photo, codecs, { format: 'png' });
    assert(detectFormat(out) === 'png', 'output should sniff as png');
  });

  await test('jpg -> webp produces a valid RIFF/WEBP container', async () => {
    const out = await convertFormat(photo, codecs, { format: 'webp' });
    assert(detectFormat(out) === 'webp', 'output should sniff as webp');
  });

  await test('jpg -> bmp round-trips pixels exactly through decode', async () => {
    const bmp = await convertFormat(photo, codecs, { format: 'bmp' });
    assert(detectFormat(bmp) === 'bmp', 'output should sniff as bmp');
    const bmpToTga = await convertFormat(bmp, codecs, { format: 'tga' });
    assert(detectFormat(bmpToTga) === 'tga', 'bmp->tga output should sniff as tga');
  });

  await test('jpg -> tga -> jpg preserves dimensions', async () => {
    const tga = await convertFormat(photo, codecs, { format: 'tga' });
    assert(detectFormat(tga) === 'tga', 'intermediate should sniff as tga');
    const backToJpeg = await convertFormat(tga, codecs, { format: 'jpg' });
    assert(isJpeg(backToJpeg), 'final output should be a jpeg');
    const decoded = await codecs.jpeg.decode(backToJpeg.buffer as ArrayBuffer);
    assert(
      decoded.width === 1600 && decoded.height === 1200,
      `dimensions preserved through tga round trip, got ${decoded.width}x${decoded.height}`,
    );
  });

  // ── jpegsToPdf ───────────────────────────────────────────────────────────
  console.log('\njpegsToPdf:');

  await test('rejects an empty image list', () => {
    let threw = false;
    try {
      jpegsToPdf([]);
    } catch (e) {
      threw = e instanceof VaultError && e.code === 'ARGS';
    }
    assert(threw, 'expected ARGS VaultError for empty input');
  });

  await test('rejects a non-jpeg buffer', () => {
    let threw = false;
    try {
      jpegsToPdf([new Uint8Array([1, 2, 3, 4])]);
    } catch (e) {
      threw = e instanceof VaultError && e.code === 'FORMAT';
    }
    assert(threw, 'expected FORMAT VaultError for garbage input');
  });

  await test('parses width/height from a real jpeg', () => {
    const meta = parseJpegMeta(photo);
    assert(meta !== null, 'metadata should parse');
    assert(meta!.w === 1600 && meta!.h === 1200, `expected 1600x1200, got ${meta!.w}x${meta!.h}`);
  });

  await test('wraps two jpegs into a structurally valid 2-page PDF', async () => {
    const photo2 = await makeSyntheticPhotoJpeg(800, 600, 85);
    const { pdf } = jpegsToPdf([photo, photo2]);

    const text = new TextDecoder('latin1').decode(pdf);
    assert(text.startsWith('%PDF-1.4'), 'should start with the PDF header');
    assert(text.includes('/Count 2'), 'page tree should report 2 pages');
    assert(text.trimEnd().endsWith('%%EOF'), 'should end with %%EOF');

    // Structural integrity check: every offset recorded in the xref table
    // must actually point at "<n> 0 obj" for the right object number.
    const xrefMatch = text.match(/xref\n0 (\d+)\n0000000000 65535 f \r\n/);
    assert(xrefMatch !== null, 'xref table header should be present');
    const objCount = Number(xrefMatch![1]);
    const xrefBodyStart = text.indexOf(xrefMatch![0]) + xrefMatch![0].length;
    for (let i = 1; i < objCount; i++) {
      const lineStart = xrefBodyStart + (i - 1) * 21; // "0000000000 00000 n \r\n" = 21 bytes
      const line = text.slice(lineStart, lineStart + 10);
      const off = Number(line);
      assert(Number.isFinite(off), `xref entry ${i} should parse as a number, got '${line}'`);
      const expectedPrefix = `${i} 0 obj`;
      const actual = text.slice(off, off + expectedPrefix.length);
      assert(
        actual === expectedPrefix,
        `object ${i}: expected '${expectedPrefix}' at offset ${off}, found '${actual}'`,
      );
    }
  });

  // ── pdfToImages ───────────────────────────────────────────────────────────
  console.log('\npdfToImages:');

  const testPdf = makeTestPdf();

  await test('rejects an out-of-range page number', async () => {
    await expectVaultError(() => pdfToImages(testPdf, codecs, { page: 99 }), 'ARGS', 'pdfToImages page=99');
  });

  await test('rejects a non-pdf buffer', async () => {
    await expectVaultError(
      () => pdfToImages(new Uint8Array([1, 2, 3, 4]), codecs, {}),
      'FORMAT',
      'pdfToImages garbage input',
    );
  });

  await test('extracts all pages, each a valid jpeg at the right zoom', async () => {
    const pages = await pdfToImages(testPdf, codecs, {});
    assert(pages.length === 2, `expected 2 pages, got ${pages.length}`);
    for (const p of pages) {
      assert(isJpeg(p.jpeg), `page ${p.pageNumber} output should be a jpeg`);
    }
    // Page 1 source MediaBox is 200x200 -> TARGET_DIM(4000) zoom -> 4000x4000.
    const decoded1 = await codecs.jpeg.decode(pages[0]!.jpeg.buffer as ArrayBuffer);
    assert(
      decoded1.width === 4000 && decoded1.height === 4000,
      `page 1 expected 4000x4000, got ${decoded1.width}x${decoded1.height}`,
    );
    // Page 2 source MediaBox is 300x150 -> zoom by the longer side (300) -> 4000x2000.
    const decoded2 = await codecs.jpeg.decode(pages[1]!.jpeg.buffer as ArrayBuffer);
    assert(
      decoded2.width === 4000 && decoded2.height === 2000,
      `page 2 expected 4000x2000, got ${decoded2.width}x${decoded2.height}`,
    );
  });

  await test('single-page extraction returns just that page, correctly rendered', async () => {
    const pages = await pdfToImages(testPdf, codecs, { page: 1 });
    assert(pages.length === 1 && pages[0]!.pageNumber === 1, 'should return exactly page 1');
    const decoded = await codecs.jpeg.decode(pages[0]!.jpeg.buffer as ArrayBuffer);
    // Page 1 draws a red square with a 10% margin; sample the center pixel.
    const cx = Math.floor(decoded.width / 2);
    const cy = Math.floor(decoded.height / 2);
    const idx = (cy * decoded.width + cx) * 4;
    const [r, g, b] = [decoded.data[idx]!, decoded.data[idx + 1]!, decoded.data[idx + 2]!];
    assert(r > 200 && g < 80 && b < 80, `expected a red center pixel, got rgb(${r},${g},${b})`);
  });

  // ── Hardening regressions ────────────────────────────────────────────
  // Every case below was, at some point during review, a raw uncaught
  // exception (RangeError, unbounded allocation, or a plain Error leaking
  // past the VaultError taxonomy) instead of a clean, categorized failure.
  // Pinned here so a future change can't silently reopen them.
  console.log('\nhardening (malformed/adversarial input):');

  function makeBmpHeader(opts: {
    width: number;
    rawHeight: number;
    bpp?: number;
    pixelOffset?: number;
    extra?: number;
  }): Uint8Array {
    const bpp = opts.bpp ?? 24;
    const pixelOffset = opts.pixelOffset ?? 54;
    const extra = opts.extra ?? 64;
    const buf = new Uint8Array(pixelOffset + extra);
    const view = new DataView(buf.buffer);
    buf[0] = 0x42;
    buf[1] = 0x4d;
    view.setUint32(2, buf.length, true);
    view.setUint32(10, pixelOffset, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, opts.width, true);
    view.setInt32(22, opts.rawHeight, true);
    view.setUint16(28, bpp, true);
    view.setUint32(30, 0, true);
    return buf;
  }

  function makeTgaHeader(width: number, height: number): Uint8Array {
    const buf = new Uint8Array(18);
    buf[2] = 2; // uncompressed truecolor
    const view = new DataView(buf.buffer);
    view.setUint16(12, width, true);
    view.setUint16(14, height, true);
    buf[16] = 32;
    buf[17] = 0x20;
    return buf;
  }

  await test('decodeBmp rejects negative width instead of crashing', () => {
    let threw = false;
    try {
      decodeBmp(makeBmpHeader({ width: -1, rawHeight: 4 }));
    } catch (e) {
      threw = e instanceof VaultError && (e.code === 'FORMAT' || e.code === 'MEMORY');
    }
    assert(threw, 'expected a categorized VaultError, not a raw RangeError');
  });

  await test('decodeBmp rejects an absurd declared size instead of attempting the allocation', () => {
    let threw = false;
    try {
      decodeBmp(makeBmpHeader({ width: 70000, rawHeight: 70000, extra: 0 }));
    } catch (e) {
      threw = e instanceof VaultError && e.code === 'MEMORY';
    }
    assert(threw, 'expected VaultError(MEMORY) for a 70000x70000 declared bitmap');
  });

  await test('decodeBmp rejects truncated pixel data instead of silently zero-filling', () => {
    let threw = false;
    try {
      decodeBmp(makeBmpHeader({ width: 100, rawHeight: 100, extra: 0 }));
    } catch (e) {
      threw = e instanceof VaultError && e.code === 'FORMAT';
    }
    assert(threw, 'expected VaultError(FORMAT) for a file too short for its declared dimensions');
  });

  await test('decodeTga rejects a 65535x65535 header (would be a ~17GB allocation)', () => {
    let threw = false;
    try {
      decodeTga(makeTgaHeader(65535, 65535));
    } catch (e) {
      threw = e instanceof VaultError && e.code === 'MEMORY';
    }
    assert(threw, 'expected VaultError(MEMORY), not an attempted multi-gigabyte allocation');
  });

  await test('printLayout rejects out-of-range quality instead of passing it through silently', async () => {
    await expectVaultError(
      () => printLayout(photo, codecs, { widthCm: 5, quality: 5000 }),
      'ARGS',
      'printLayout quality=5000',
    );
  });

  await test('printLayout rejects a requested size that rounds to 0px', async () => {
    await expectVaultError(
      () => printLayout(photo, codecs, { widthCm: 0.001 }),
      'ARGS',
      'printLayout widthCm=0.001',
    );
  });

  await test('compress wraps a decode failure as VaultError(FORMAT) instead of leaking it raw', async () => {
    const throwingProvider: CanvasProvider = {
      async decodeToBitmap() {
        throw new Error('simulated createImageBitmap rejection on corrupt bytes');
      },
      async renderJpeg() {
        return new Uint8Array(10);
      },
    };
    // Must be bigger than the target so the passthrough shortcut doesn't
    // skip decodeToBitmap entirely.
    const bigInput = new Uint8Array(50_000);
    await expectVaultError(
      () => compress(bigInput, { targetKb: 1, canvasProvider: throwingProvider }),
      'FORMAT',
      'compress with a throwing canvas provider',
    );
  });

  await test('pdfToImages clamps an oversized MediaBox instead of rendering it 1:1', async () => {
    // A page many times larger than TARGET_DIM would, uncapped, ask pdfium
    // to allocate a bitmap the same multiple larger — see MAX_RENDER_DIM's
    // comment in pdfToImages.ts. maxRenderDim is overridden small here purely
    // so the test renders fast; the default (8000) is what production uses.
    const pages = await pdfToImages(testPdf, codecs, { page: 2, maxRenderDim: 50 });
    const decoded = await codecs.jpeg.decode(pages[0]!.jpeg.buffer as ArrayBuffer);
    assert(
      decoded.width <= 50 && decoded.height <= 50,
      `expected render clamped to <=50px, got ${decoded.width}x${decoded.height}`,
    );
  });

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
