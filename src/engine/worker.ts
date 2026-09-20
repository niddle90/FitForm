/**
 * Engine worker — runs entirely off the main thread.
 *
 * This is the ONLY file in this app that imports 'imaging'. The UI
 * talks to it exclusively through the typed message protocol in
 * ./types.ts, via the client in ./client.ts. That boundary is
 * deliberate: imaging's own WASM codecs (mozjpeg, png, webp, resize,
 * pdfium, jpegopt) are heavy to initialize and CPU-heavy to run, so doing
 * both off the main thread is what keeps the UI responsive while a
 * bisection search or a page render is in flight.
 */

import {
  VaultError,
  compress,
  printLayout,
  convertFormat,
  pdfToImages,
  jpegsToPdf,
  parseJpegMeta,
  detectFormat,
  encodeBmp,
  encodeTga,
  assertDecodableImageSize,
} from 'imaging';
import type { VaultCodecs, JpegOptEngine, CropAnchor } from 'imaging';
import { createBrowserCodecs, createJpegOptEngineBrowser } from 'imaging/browser';
// Primed directly (not through imaging) so every @jsquash/resize
// method is available from the UI, not just the 'lanczos3' imaging's
// own printLayout hardcodes — see scripts/copy-wasm-assets.mjs's comment.
import { initHqx, initMagicKernel } from '@jsquash/resize';
import { parseHeaderDimensions } from './imageMeta';

import type {
  WorkerRequest,
  WorkerMessage,
  WorkerResponsePayload,
  PipelineConfig,
  StageResultMeta,
  RunResult,
  ImageFormat,
  ResizeMethod,
  CropOffset,
  CropRect,
  PdfExtractedPage,
  InspectInfo,
} from './types';

// worker global scope, cast loosely to sidestep DOM-vs-WebWorker lib
// clashes in the shared tsconfig (this file only ever runs as a worker).
const ctx: any = self;

let codecs: Required<VaultCodecs> | null = null;
let wasmEngine: JpegOptEngine | null = null;
let ready: Promise<void> | null = null;

function post(msg: WorkerMessage, transfer?: Transferable[]) {
  ctx.postMessage(msg, transfer ?? []);
}
function log(id: number, stage: string, message: string) {
  post({ id, type: 'log', stage, message });
}
function progress(id: number, stage: string, status: 'start' | 'done' | 'error') {
  post({ id, type: 'progress', stage, status });
}
function result(id: number, payload: WorkerResponsePayload, transfer?: Transferable[]) {
  post({ id, type: 'result', payload }, transfer);
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
    return u8.buffer as ArrayBuffer;
  }
  return u8.slice().buffer as ArrayBuffer;
}

const MIME: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tga: 'image/x-tga',
};

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// ── one-time engine bootstrap ───────────────────────────────────────────

async function ensureReady(id: number): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    // Base-aware so this still resolves correctly if the app is deployed
    // under a subpath (e.g. GitHub Pages' https://host/fitform/) rather
    // than domain root — import.meta.env.BASE_URL is Vite's own base
    // config, always correct for wherever `public/` (and therefore
    // public/wasm/) actually gets served from, in both dev and build.
    // ctx.location.origin alone would silently drop that subpath.
    const assetBaseUrl = new URL(`${import.meta.env.BASE_URL}wasm/`, ctx.location.href);
    log(id, 'init', 'fetching codec assets (mozjpeg, png, webp, resize, pdfium)…');
    codecs = await createBrowserCodecs({ assetBaseUrl });
    log(id, 'init', 'jSquash + pdfium codecs ready');

    log(id, 'init', 'loading native jpegopt WASM compression core…');
    wasmEngine = await createJpegOptEngineBrowser();
    log(id, 'init', 'jpegopt engine ready (deterministic libjpeg-turbo path)');

    log(id, 'init', 'priming extra resize kernels (hqx, magic-kernel)…');
    const [hqxBuf, mkBuf] = await Promise.all([
      fetch(new URL('squooshhqx_bg.wasm', assetBaseUrl)).then((r) => r.arrayBuffer()),
      fetch(new URL('jsquash_magic_kernel_bg.wasm', assetBaseUrl)).then((r) => r.arrayBuffer()),
    ]);
    await initHqx(hqxBuf);
    await initMagicKernel(mkBuf);

    log(id, 'init', 'all engines ready');
  })();
  return ready;
}

// ── shared decode helper (used only by the standalone Resize step) ─────
//
// imaging's public API exposes JpegCodec/PngCodec/WebpCodec.decode()
// directly, but BMP/TGA decoding lives inside convertFormat and isn't exported.
// To stay strictly on the public surface, BMP/TGA input is normalized to
// PNG via convertFormat first, then decoded through the public PNG codec.

async function decodeToImageData(bytes: Uint8Array, format: ImageFormat): Promise<ImageData> {
  const c = codecs!;
  // Same declared-size check convertFormat now runs before its own jpg/png/webp
  // decodes (see decode-guard.ts) — this call site decodes independently
  // of convertFormat (Resize/Crop/inspect's fallback all land here), so it needs
  // the same guard rather than inheriting convertFormat's.
  if (format === 'jpg' || format === 'png' || format === 'webp') {
    assertDecodableImageSize('worker', bytes, format);
  }
  switch (format) {
    case 'jpg':
      return c.jpeg.decode(toArrayBuffer(bytes));
    case 'png':
      return c.png.decode(toArrayBuffer(bytes));
    case 'webp':
      return c.webp.decode(toArrayBuffer(bytes));
    case 'bmp':
    case 'tga': {
      const png = await convertFormat(bytes, c, { format: 'png', quality: 100 });
      return c.png.decode(toArrayBuffer(png));
    }
    default:
      throw new Error(`unsupported format: ${format}`);
  }
}

async function encodeFromImageData(image: ImageData, format: ImageFormat): Promise<Uint8Array> {
  const c = codecs!;
  switch (format) {
    case 'jpg':
      return new Uint8Array(await c.jpeg.encode(image, { quality: 95 }));
    case 'png':
      return new Uint8Array(await c.png.encode(image));
    case 'webp':
      return new Uint8Array(await c.webp.encode(image, { quality: 95 }));
    case 'bmp':
      return encodeBmp(image);
    case 'tga':
      return encodeTga(image);
    default:
      throw new Error(`unsupported format: ${format}`);
  }
}

// ── crop (pixel-level cover-crop, independent of Compress) ─────────────
//
// Cropping used to be implemented by routing through the WASM compress
// engine with a deliberately huge target size — it worked, but it meant
// every "just crop" request silently forced JPEG output (the wasm engine
// only speaks JPEG) even for a PNG/WebP/BMP/TGA source, and even a JPEG
// source picked up an extra, unrequested lossy generation at whatever
// quality the bisection landed on. This does the crop directly against
// decoded pixels and re-encodes in the *same* format the input already
// was, so "crop" never changes the format, for any source format.
//
// That is NOT the same as "no recompression", though, and this used to
// be documented as if it were. PNG/BMP/TGA re-encode losslessly, so
// crop really is lossless for those. JPEG and WebP don't have a
// lossless re-encode path here (encodeFromImageData always calls
// c.jpeg.encode/c.webp.encode at a fixed q95), so cropping a JPEG or
// WebP is a same-format but still lossy re-encode — an extra generation
// of compression the user didn't explicitly ask for, same trade-off
// Resize makes for "Same as original" (see the preserveOriginalFormat
// comment below). If lossless JPEG pixels matter, this architecture
// would need a dedicated lossless-JPEG-crop path (block-aligned crop
// without a full decode/re-encode round trip); it doesn't have one.

function coverCropOrigin(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number,
  anchor: CropAnchor,
  offset?: CropOffset,
): { x: number; y: number } {
  const maxX = Math.max(0, sourceW - targetW);
  const maxY = Math.max(0, sourceH - targetH);
  // A freely-dragged position (from CropPositioner) wins outright when
  // present — it already encodes exactly where within the slack the user
  // wants, on whichever axis actually has slack. `anchor`'s five presets
  // are a fallback for configs built without that UI attached.
  if (offset) {
    const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
    return { x: Math.round(maxX * clamp01(offset.x)), y: Math.round(maxY * clamp01(offset.y)) };
  }
  switch (anchor) {
    case 'top':
      return { x: Math.round(maxX / 2), y: 0 };
    case 'bottom':
      return { x: Math.round(maxX / 2), y: maxY };
    case 'left':
      return { x: 0, y: Math.round(maxY / 2) };
    case 'right':
      return { x: maxX, y: Math.round(maxY / 2) };
    case 'center':
    default:
      return { x: Math.round(maxX / 2), y: Math.round(maxY / 2) };
  }
}

function sliceImageData(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOffset = ((y + row) * src.width + x) * 4;
    out.set(src.data.subarray(srcOffset, srcOffset + w * 4), row * w * 4);
  }
  return new ImageData(out, w, h);
}

/** Converts a CropRect (fractions of the source) into clamped, in-bounds source pixels. */
function rectToPixels(rect: CropRect, sourceW: number, sourceH: number): { x: number; y: number; w: number; h: number } {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const x = Math.min(sourceW - 1, Math.round(clamp01(rect.x) * sourceW));
  const y = Math.min(sourceH - 1, Math.round(clamp01(rect.y) * sourceH));
  const w = Math.max(1, Math.min(sourceW - x, Math.round(clamp01(rect.w) * sourceW)));
  const h = Math.max(1, Math.min(sourceH - y, Math.round(clamp01(rect.h) * sourceH)));
  return { x, y, w, h };
}

async function coverCrop(
  decoded: ImageData,
  targetW: number,
  targetH: number,
  anchor: CropAnchor,
  method: ResizeMethod,
  onLog: (m: string) => void,
  offset?: CropOffset,
): Promise<ImageData> {
  const c = codecs!;
  const scale = Math.max(targetW / decoded.width, targetH / decoded.height);
  let source = decoded;
  if (Math.abs(scale - 1) > 1e-6) {
    const scaledW = Math.max(targetW, Math.round(decoded.width * scale));
    const scaledH = Math.max(targetH, Math.round(decoded.height * scale));
    onLog(`scaling ${decoded.width}x${decoded.height} -> ${scaledW}x${scaledH} to cover ${targetW}x${targetH}`);
    source = await c.resize.resize(decoded, { width: scaledW, height: scaledH, method });
  }
  const { x, y } = coverCropOrigin(source.width, source.height, targetW, targetH, anchor, offset);
  onLog(
    offset
      ? `cropping to ${targetW}x${targetH} at offset=(${offset.x.toFixed(2)}, ${offset.y.toFixed(2)}) (x=${x}, y=${y})`
      : `cropping to ${targetW}x${targetH} at anchor=${anchor} (x=${x}, y=${y})`,
  );
  return sliceImageData(source, x, y, targetW, targetH);
}

// ── inspect (instant metadata, no pipeline run) ─────────────────────────

async function inspect(bytes: Uint8Array): Promise<InspectInfo> {
  const format = detectFormat(bytes) as ImageFormat | null;
  if (!format) return { format: null };
  const jpegMeta = format === 'jpg' ? parseJpegMeta(bytes) : null;
  if (jpegMeta) return { format, width: jpegMeta.w, height: jpegMeta.h, jpegMeta };
  const header = parseHeaderDimensions(bytes, format);
  if (header) return { format, width: header.width, height: header.height };
  try {
    // Header parsing doesn't cover this format/variant — fall back to a
    // full decode (allocates a full RGBA buffer) as a last resort.
    const decoded = await decodeToImageData(bytes, format);
    return { format, width: decoded.width, height: decoded.height };
  } catch {
    // Decode can fail on a recognized-but-corrupt file; still report the
    // format sniffed from magic bytes rather than throwing away useful info.
    return { format };
  }
}

// ── pdf helpers ──────────────────────────────────────────────────────────

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdfium = codecs!.pdfium;
  const ptr = pdfium.heap.malloc(bytes.length);
  if (!ptr) throw new Error('out of memory loading pdf into the pdfium heap');
  try {
    pdfium.heap.getHEAPU8().set(bytes, ptr);
    const doc = pdfium.FPDF_LoadMemDocument64(ptr, bytes.length, '');
    if (!doc) {
      throw new Error(`not a readable PDF (pdfium error ${pdfium.FPDF_GetLastError()})`);
    }
    try {
      return pdfium.FPDF_GetPageCount(doc);
    } finally {
      pdfium.FPDF_CloseDocument(doc);
    }
  } finally {
    pdfium.heap.free(ptr);
  }
}

async function pdfExtract(
  id: number,
  bytes: Uint8Array,
  page: number | null,
  quality: number,
  maxRenderDim: number,
): Promise<PdfExtractedPage[]> {
  const pages = await pdfToImages(bytes, codecs!, {
    page: page ?? undefined,
    quality,
    maxRenderDim,
    onLog: (m) => log(id, 'pdf', m),
  });
  return pages.map((p) => {
    const meta = parseJpegMeta(p.jpeg);
    return { pageNumber: p.pageNumber, jpeg: p.jpeg, width: meta?.w ?? 0, height: meta?.h ?? 0 };
  });
}

// ── the pipeline ─────────────────────────────────────────────────────────

async function runPipeline(
  id: number,
  input: Uint8Array,
  filenameHint: string,
  config: PipelineConfig,
): Promise<RunResult> {
  const c = codecs!;
  const stages: StageResultMeta[] = [];

  let current = input;
  let format = detectFormat(current) as ImageFormat | null;
  // Captured before Resize/Crop touch `format` — this is what "Same as
  // original" actually refers to. Needed below so Resize knows what
  // "preserve the format" means when nothing lossy runs after it.
  const originalFormat = format;
  const jpegMeta = format === 'jpg' ? parseJpegMeta(current) : null;
  const headerMeta = !jpegMeta && format ? parseHeaderDimensions(current, format) : null;
  const sourceW = jpegMeta?.w ?? headerMeta?.width;
  const sourceH = jpegMeta?.h ?? headerMeta?.height;
  log(id, 'source', `${current.byteLength.toLocaleString()} bytes, detected format: ${format ?? 'unrecognized'}`);
  stages.push({
    stage: 'source',
    label: 'Source',
    bytes: current.byteLength,
    format: format ?? undefined,
    width: sourceW,
    height: sourceH,
  });

  // ── Resize ───────────────────────────────────────────────────────────
  if (config.resize.enabled) {
    progress(id, 'resize', 'start');
    try {
      if (!format) throw new Error('cannot resize: input is not a recognized image format');
      log(id, 'resize', `decoding ${format} for pixel-level resize…`);
      let decoded: ImageData | null = await decodeToImageData(current, format);
      const decodedW = decoded.width;
      const decodedH = decoded.height;

      let targetW = config.resize.width;
      let targetH = config.resize.height;
      if (config.resize.lockAspect) {
        if (targetW && !targetH) targetH = Math.max(1, Math.round((targetW * decodedH) / decodedW));
        else if (targetH && !targetW) targetW = Math.max(1, Math.round((targetH * decodedW) / decodedH));
      }
      if (!targetW || !targetH) throw new Error('resize needs at least a target width or height');

      let resized: ImageData;
      if (targetW === decodedW && targetH === decodedH) {
        log(id, 'resize', `target ${targetW}x${targetH} already matches source — skipping`);
        resized = decoded;
      } else {
        log(id, 'resize', `${decodedW}x${decodedH} -> ${targetW}x${targetH} (${config.resize.method})`);
        resized = await c.resize.resize(decoded, { width: targetW, height: targetH, method: config.resize.method });
      }
      // `resized` now holds everything the rest of this stage needs — either
      // the very same buffer as `decoded` (the "already matches" no-op case
      // above) or a brand-new one from c.resize.resize(). Either way `decoded`
      // itself is dead from here on, but an async function's local variables
      // stay rooted across every `await` it suspends at until they're
      // reassigned or the function returns — V8 compiles a suspended async
      // function's scope into a captured continuation, and an unreferenced
      // local doesn't stop being "referenced" just because the code below
      // never reads it again. Three more `await`s follow in this stage alone
      // (the encode call below) before `current` gets reassigned, each one a
      // point where `decoded`'s full-resolution pixel buffer — tens of MB for
      // a large photo, exactly the mobile memory-pressure case the original
      // review flagged — would otherwise still be sitting on the heap for no
      // reason. Null it out explicitly so it's eligible for collection before
      // those awaits, instead of riding along until this whole stage (or
      // worse, this whole pipeline run, if a later stage also awaits) finishes.
      decoded = null;

      // The Compress stage always ends in JPEG (compress only ever produces
      // JPEG bytes — see its module doc). If Compress is enabled next,
      // materializing a lossless PNG here is pure waste: it inflates a
      // resized 6000x4000 photo to tens of MB just so Compress immediately
      // decodes it again and throws that fidelity away re-encoding to
      // JPEG. Skip straight to a high-quality JPEG intermediate instead —
      // one extra lossy generation at q95 is negligible next to a
      // bisection search that's about to target a much smaller size
      // anyway, and it avoids doubling peak memory on mobile.
      //
      // When Compress is off, what to encode as depends on what happens
      // *after* Resize:
      //  - Convert is enabled -> it's about to re-encode to whatever
      //    format the user picked anyway, so a lossless PNG intermediate
      //    costs nothing and avoids pre-baking loss.
      //  - Convert is off and Final isn't a PDF bind -> the user picked
      //    "Same as original", which has to mean what it says: encode
      //    straight back into the *original* format rather than always
      //    landing on PNG. For a JPEG source that means accepting a JPEG
      //    re-encode (see the Crop step below, which makes the same
      //    trade-off) — still far more faithful to "same format" than
      //    silently changing it.
      //  - Final is a PDF bind -> jpegsToPdf wants JPEG regardless, and the
      //    bind step already re-converts non-JPEG input itself, so a
      //    lossless PNG intermediate is a fine, loss-avoiding default.
      const nextIsLossyCompress = config.compress.enabled;
      const preserveOriginalFormat =
        !nextIsLossyCompress && !config.convert.enabled && config.final.kind !== 'bind' && !!originalFormat;
      if (nextIsLossyCompress) {
        current = new Uint8Array(await c.jpeg.encode(resized, { quality: 95 }));
        format = 'jpg';
        stages.push({ stage: 'resize', label: 'Resize', bytes: current.byteLength, width: targetW, height: targetH, format });
        log(id, 'resize', `re-encoded as JPEG q95 (${current.byteLength.toLocaleString()} bytes) — Compress runs next and would re-encode anyway, so skipping the lossless PNG intermediate`);
      } else if (preserveOriginalFormat) {
        current = await encodeFromImageData(resized, originalFormat);
        format = originalFormat;
        stages.push({ stage: 'resize', label: 'Resize', bytes: current.byteLength, width: targetW, height: targetH, format });
        log(id, 'resize', `re-encoded as ${format} (${current.byteLength.toLocaleString()} bytes) — "Same as original" keeps the source format instead of forcing PNG`);
      } else {
        current = new Uint8Array(await c.png.encode(resized));
        format = 'png';
        stages.push({ stage: 'resize', label: 'Resize', bytes: current.byteLength, width: targetW, height: targetH, format });
        log(id, 'resize', `re-encoded as lossless PNG (${current.byteLength.toLocaleString()} bytes) — pick a different output format in Convert`);
      }
      progress(id, 'resize', 'done');
    } catch (e) {
      progress(id, 'resize', 'error');
      throw e;
    }
  }

  // ── Crop ─────────────────────────────────────────────────────────────
  if (config.crop.enabled) {
    progress(id, 'crop', 'start');
    try {
      if (!format) throw new Error('cannot crop: input is not a recognized image format');
      const mode = config.crop.mode;
      log(id, 'crop', `decoding ${format} for pixel-level crop…`);
      let decoded: ImageData | null = await decodeToImageData(current, format);
      let cropped: ImageData;
      let outW: number;
      let outH: number;

      if (mode === 'free') {
        // No target size at all — the user's own selection *is* the
        // output size. Nothing to resize afterward.
        if (!config.crop.rect) throw new Error('free crop needs a selection rectangle');
        const px = rectToPixels(config.crop.rect, decoded.width, decoded.height);
        log(id, 'crop', `cutting free selection ${px.w}x${px.h} at (${px.x}, ${px.y})`);
        cropped = sliceImageData(decoded, px.x, px.y, px.w, px.h);
        outW = px.w;
        outH = px.h;
      } else if (mode === 'zoom') {
        // An arbitrary (aspect-locked, in the UI) selection, cut out and
        // then resized to hit width x height exactly — unlike 'cover',
        // the selection itself can be smaller or larger than the
        // minimum-crop box, trading a resize for how much gets cropped away.
        const targetW = config.crop.width;
        const targetH = config.crop.height;
        if (!targetW || !targetH) throw new Error('crop needs both a target width and height');
        if (!config.crop.rect) throw new Error('zoom crop needs a selection rectangle');
        const px = rectToPixels(config.crop.rect, decoded.width, decoded.height);
        log(
          id,
          'crop',
          `cutting selection ${px.w}x${px.h} at (${px.x}, ${px.y}), then fitting to ${targetW}x${targetH}`,
        );
        const sliced = sliceImageData(decoded, px.x, px.y, px.w, px.h);
        cropped =
          sliced.width === targetW && sliced.height === targetH
            ? sliced
            : await c.resize.resize(sliced, { width: targetW, height: targetH, method: config.crop.method });
        outW = targetW;
        outH = targetH;
      } else {
        // 'cover' (default): the minimum crop that reaches width x
        // height exactly, no stretch — see coverCrop's own doc comment.
        const targetW = config.crop.width;
        const targetH = config.crop.height;
        if (!targetW || !targetH) throw new Error('crop needs both a target width and height');
        cropped = await coverCrop(
          decoded,
          targetW,
          targetH,
          config.crop.anchor,
          config.crop.method,
          (m) => log(id, 'crop', m),
          config.crop.offset,
        );
        outW = targetW;
        outH = targetH;
      }
      // Same reasoning as Resize's `decoded = null` above: every branch
      // above hands back a distinct buffer (sliceImageData() allocates a
      // fresh one even when no resize follows), so `decoded` is
      // unconditionally dead here — but it stays rooted across the
      // encode `await` below unless dropped explicitly.
      decoded = null;
      current = await encodeFromImageData(cropped, format);
      stages.push({ stage: 'crop', label: 'Crop', bytes: current.byteLength, width: outW, height: outH, format });
      const recompressed = format === 'jpg' || format === 'webp';
      log(
        id,
        'crop',
        `re-encoded as ${format} (${current.byteLength.toLocaleString()} bytes) — same format as the input, no forced JPEG conversion` +
          (recompressed ? `, but still a lossy re-encode at q95 since ${format} has no lossless path here` : ' (lossless)'),
      );
      progress(id, 'crop', 'done');
    } catch (e) {
      progress(id, 'crop', 'error');
      throw e;
    }
  }

  // ── Compress ─────────────────────────────────────────────────────────
  if (config.compress.enabled) {
    progress(id, 'compress', 'start');
    try {
      let working = current;
      if (config.compress.engine === 'wasm' && format !== 'jpg') {
        log(id, 'compress', `wasm engine requires JPEG input — auto-converting from ${format ?? 'unknown'} first`);
        working = await convertFormat(working, c, { format: 'jpg', quality: 95 });
      }
      const useDims = config.compress.useDimensions;
      const r = await compress(working, {
        targetKb: config.compress.targetKb,
        engine: config.compress.engine,
        wasmEngine: wasmEngine!,
        resolveWithObject: true,
        width: useDims ? config.compress.width : undefined,
        height: useDims ? config.compress.height : undefined,
        fixedDimension: useDims ? config.compress.fixedDimension : undefined,
        cropAnchor: config.compress.cropAnchor,
        minQuality: config.compress.minQuality,
        maxScaleTries: config.compress.maxScaleTries,
        subsampling: config.compress.subsampling,
        progressive: config.compress.progressive,
        allowMiss: config.compress.allowMiss,
        onLog: (m) => log(id, 'compress', m),
      });
      current = r.data;
      format = 'jpg';
      stages.push({
        stage: 'compress',
        label: 'Compress',
        bytes: current.byteLength,
        width: r.width,
        height: r.height,
        format,
        extra: {
          engine: r.engine,
          ...(r.quality !== undefined ? { quality: r.quality } : {}),
          ...(r.metTarget !== undefined ? { metTarget: r.metTarget } : {}),
        },
      });
      progress(id, 'compress', 'done');
    } catch (e) {
      progress(id, 'compress', 'error');
      throw e;
    }
  }

  // ── Convert ──────────────────────────────────────────────────────────
  if (config.convert.enabled) {
    progress(id, 'convert', 'start');
    try {
      if (!format) throw new Error('cannot convert: current image is not a recognized format');
      log(id, 'convert', `${format} -> ${config.convert.format}`);
      current = await convertFormat(current, c, {
        format: config.convert.format,
        quality: config.convert.quality,
        onLog: (m) => log(id, 'convert', m),
      });
      format = config.convert.format;
      stages.push({ stage: 'convert', label: 'Convert', bytes: current.byteLength, format });
      progress(id, 'convert', 'done');
    } catch (e) {
      progress(id, 'convert', 'error');
      throw e;
    }
  }

  // ── Final: print layout or PDF bind ─────────────────────────────────
  let mime = format ? MIME[format] : 'application/octet-stream';
  let filename = `${baseName(filenameHint)}.${format ?? 'bin'}`;

  if (config.final.kind === 'print') {
    progress(id, 'print', 'start');
    try {
      let working = current;
      if (format !== 'jpg') {
        log(id, 'print', `printLayout decodes JPEG only — auto-converting from ${format ?? 'unknown'} first`);
        working = await convertFormat(working, c, { format: 'jpg', quality: 95 });
      }
      const f = config.final;
      const printed = await printLayout(
        working,
        { jpeg: c.jpeg, resize: c.resize },
        {
          widthCm: f.sizeMode === 'width' ? f.widthCm : undefined,
          heightCm: f.sizeMode === 'height' ? f.heightCm : undefined,
          topCm: f.topCm,
          leftCm: f.hAlign === 'left' ? f.leftCm : undefined,
          rightCm: f.hAlign === 'right' ? f.rightCm : undefined,
          center: f.hAlign === 'center' ? true : undefined,
          quality: f.quality,
          onLog: (m) => log(id, 'print', m),
        },
      );
      current = printed;
      format = 'jpg';
      const pxPerCm = 300 / 2.54;
      const cw = Math.round(21.0 * pxPerCm);
      const ch = Math.round(29.7 * pxPerCm);
      stages.push({ stage: 'print', label: 'Print layout (A4 @ 300dpi)', bytes: current.byteLength, width: cw, height: ch, format });
      mime = 'image/jpeg';
      filename = `${baseName(filenameHint)}-print.jpg`;
      progress(id, 'print', 'done');
    } catch (e) {
      progress(id, 'print', 'error');
      throw e;
    }
  } else if (config.final.kind === 'bind') {
    progress(id, 'bind', 'start');
    try {
      let working = current;
      if (format !== 'jpg') {
        log(id, 'bind', `jpegsToPdf requires JPEG bytes — auto-converting from ${format ?? 'unknown'} first`);
        working = await convertFormat(working, c, { format: 'jpg', quality: 95 });
      }
      log(id, 'bind', 'wrapping JPEG into a single-page PDF…');
      const { pdf } = jpegsToPdf([working]);
      current = pdf;
      const meta = parseJpegMeta(working);
      stages.push({ stage: 'bind', label: 'Bind to PDF', bytes: current.byteLength, width: meta?.w, height: meta?.h, format: 'pdf' });
      mime = 'application/pdf';
      filename = `${baseName(filenameHint)}.pdf`;
      progress(id, 'bind', 'done');
    } catch (e) {
      progress(id, 'bind', 'error');
      throw e;
    }
  }

  return { data: current, mime, filename, stages };
}

// ── message dispatch ─────────────────────────────────────────────────────

// A worker is single-threaded, but that only means two requests' JS never
// literally executes at the same instant — it does not mean they can't
// interleave. Every handler below is async and awaits deep into WASM calls
// (codec decode/encode, wasmEngine, pdfium), and each `await` is a point
// where the event loop is free to start processing the *next* onmessage
// before the current one finishes. If the client ever has two calls in
// flight at once (client.ts's `call()` has no such restriction — nothing
// stops a second `run`/`pdf-extract`/etc. from being posted while one is
// still pending), their handlers would interleave on the same `codecs` /
// `wasmEngine` module-level instances. Those aren't designed for
// reentrancy: pdfium in particular manages one shared WASM heap via
// pdfium.heap.malloc/free (see pdfPageCount/pdfToImages), so an interleaved
// malloc from one call and free from another can corrupt or reuse the
// same memory out from under each other, not just race on results.
// Queue every request through this single chain so the *body* of one
// handler always finishes (result posted or error caught) before the next
// one starts — a request no longer needs to depend on the caller having
// serialized its own calls.
let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handleRequest(ev.data));
};

async function handleRequest(req: WorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'init': {
        await ensureReady(req.id);
        result(req.id, { kind: 'ready' });
        break;
      }
      case 'inspect': {
        await ensureReady(req.id);
        const info = await inspect(req.bytes);
        result(req.id, { kind: 'inspect', info });
        break;
      }
      case 'pdf-info': {
        await ensureReady(req.id);
        const pageCount = await pdfPageCount(req.bytes);
        result(req.id, { kind: 'pdf-info', pageCount });
        break;
      }
      case 'pdf-extract': {
        await ensureReady(req.id);
        const pages = await pdfExtract(req.id, req.bytes, req.page, req.quality, req.maxRenderDim);
        result(
          req.id,
          { kind: 'pdf-extract', pages },
          pages.map((p) => p.jpeg.buffer),
        );
        break;
      }
      case 'run': {
        await ensureReady(req.id);
        const r = await runPipeline(req.id, req.bytes, req.filenameHint, req.config);
        result(req.id, { kind: 'run', result: r }, [r.data.buffer]);
        break;
      }
    }
  } catch (e) {
    if (e instanceof VaultError) {
      post({ id: req.id, type: 'error', tool: e.tool, code: e.code, message: e.message });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      post({ id: req.id, type: 'error', message });
    }
  }
}
