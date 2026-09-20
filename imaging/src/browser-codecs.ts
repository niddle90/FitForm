/**
 * Real, browser-only codec wiring.
 *
 * This is the "Bundler/static-asset wiring" step from migration_v3.md §8.
 * Every `.wasm` file referenced here is one of the five pinned packages
 * from migration_v3.md §6 — nothing here is compiled by this project.
 * Exact versions currently pinned (must match package.json exactly, no
 * `^`/`~` ranges — see migration_v3.md §6 for why):
 *
 *   @jsquash/jpeg@1.6.0   @jsquash/png@3.1.1   @jsquash/resize@2.1.1
 *   @jsquash/webp@1.5.0   @embedpdf/pdfium@2.15.0
 *
 * Any version bump requires re-running the golden-file suite in test/
 * before merging (migration_v3.md §6/§7) — this file being the "source of
 * truth for what we're currently pinned to" per that section.
 *
 * The `.wasm` files must be served as static assets, not inlined by a
 * bundler (confirmed against the packages' own loader code during
 * evaluation, not just their docs — see migration_v2.md §4.1). Point
 * `assetBaseUrl` at wherever your build copies them; it defaults to the
 * same directory as this module, which is where most bundlers that copy
 * `node_modules/**\/*.wasm` alongside the JS will put them.
 *
 * compress's optional WASM engine (jpegopt) is NOT wired up here on
 * purpose — see browser-jpegopt.ts. It has no jSquash/pdfium dependency
 * of its own, so it's kept in its own module: importing only
 * browser-jpegopt.ts pulls in none of the five packages pinned above.
 */

import * as jpegEncodeMod from '@jsquash/jpeg/encode.js';
import * as jpegDecodeMod from '@jsquash/jpeg/decode.js';
import encodeJpeg from '@jsquash/jpeg/encode.js';
import decodeJpeg from '@jsquash/jpeg/decode.js';

import * as pngEncodeMod from '@jsquash/png/encode.js';
import * as pngDecodeMod from '@jsquash/png/decode.js';
import encodePng from '@jsquash/png/encode.js';
import decodePng from '@jsquash/png/decode.js';

import * as webpEncodeMod from '@jsquash/webp/encode.js';
import * as webpDecodeMod from '@jsquash/webp/decode.js';
import encodeWebp from '@jsquash/webp/encode.js';
import decodeWebp from '@jsquash/webp/decode.js';

import { initResize } from '@jsquash/resize';
import resizeImage from '@jsquash/resize';

import { init as initPdfium } from '@embedpdf/pdfium';

import type {
  JpegCodec,
  PngCodec,
  WebpCodec,
  ResizeCodec,
  PdfiumBinding,
  VaultCodecs,
} from './codecs.js';

export interface BrowserCodecAssets {
  /** Base URL (trailing slash optional) that the filenames below are resolved against. */
  assetBaseUrl?: string | URL;
  jpegDecodeWasm?: string;
  jpegEncodeWasm?: string;
  pngWasm?: string;
  webpDecodeWasm?: string;
  webpEncodeWasm?: string;
  resizeWasm?: string;
  pdfiumWasm?: string;
}

const DEFAULT_FILENAMES = {
  jpegDecodeWasm: 'mozjpeg_dec.wasm',
  jpegEncodeWasm: 'mozjpeg_enc.wasm',
  pngWasm: 'squoosh_png_bg.wasm',
  webpDecodeWasm: 'webp_dec.wasm',
  webpEncodeWasm: 'webp_enc.wasm', // baseline (non-SIMD) build; see note below
  resizeWasm: 'squoosh_resize_bg.wasm',
  pdfiumWasm: 'pdfium.wasm',
} as const;

function resolveUrl(base: string | URL | undefined, filename: string): string {
  if (!base) return filename;
  return new URL(filename, base).toString();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch codec asset ${url}: ${res.status} ${res.statusText}`);
  }
  return res.arrayBuffer();
}

/**
 * Loads and initializes every WASM codec the suite needs, once, and
 * returns a VaultCodecs object ready to hand to printLayout/convert/pdfToImages.
 *
 * NOTE on WebP SIMD: jSquash ships a separate `webp_enc_simd.wasm` build
 * (§4.1/§5 of migration_v2.md). Selecting it requires a runtime
 * WASM-SIMD feature check before choosing which asset to fetch. This
 * loader always uses the baseline (non-SIMD) encoder for simplicity and
 * determinism-of-asset-choice; swapping in SIMD detection is a follow-up,
 * not a correctness gap — the baseline encoder is still the same
 * deterministic libwebp-in-WASM build, just not the fastest available path.
 */
export async function createBrowserCodecs(
  assets: BrowserCodecAssets = {},
): Promise<Required<VaultCodecs>> {
  const base = assets.assetBaseUrl;
  const names = { ...DEFAULT_FILENAMES, ...assets };

  const [
    jpegDecWasm,
    jpegEncWasm,
    pngWasm,
    webpDecWasm,
    webpEncWasm,
    resizeWasm,
    pdfiumWasmBinary,
  ] = await Promise.all([
    fetchArrayBuffer(resolveUrl(base, names.jpegDecodeWasm)),
    fetchArrayBuffer(resolveUrl(base, names.jpegEncodeWasm)),
    fetchArrayBuffer(resolveUrl(base, names.pngWasm)),
    fetchArrayBuffer(resolveUrl(base, names.webpDecodeWasm)),
    fetchArrayBuffer(resolveUrl(base, names.webpEncodeWasm)),
    fetchArrayBuffer(resolveUrl(base, names.resizeWasm)),
    fetchArrayBuffer(resolveUrl(base, names.pdfiumWasm)),
  ]);

  await jpegDecodeMod.init({ wasmBinary: jpegDecWasm });
  await jpegEncodeMod.init({ wasmBinary: jpegEncWasm });
  const jpeg: JpegCodec = {
    decode: (buf) => decodeJpeg(buf),
    encode: (data, options) => encodeJpeg(data, options),
  };

  await pngEncodeMod.init(pngWasm);
  await pngDecodeMod.init(pngWasm);
  const png: PngCodec = {
    decode: (buf) => decodePng(buf),
    encode: (data) => encodePng(data),
  };

  await webpDecodeMod.init({ wasmBinary: webpDecWasm });
  await webpEncodeMod.init({ wasmBinary: webpEncWasm });
  const webp: WebpCodec = {
    decode: (buf) => decodeWebp(buf),
    encode: (data, options) => encodeWebp(data, options),
  };

  await initResize(resizeWasm);
  const resize: ResizeCodec = {
    resize: (data, options) =>
      resizeImage(data, { ...options, fitMethod: 'stretch', premultiply: true, linearRGB: false }),
  };

  const pdfiumModule = await initPdfium({ wasmBinary: pdfiumWasmBinary });
  pdfiumModule.PDFiumExt_Init();
  const pdfium: PdfiumBinding = {
    heap: {
      getHEAPU8: () => pdfiumModule.pdfium.HEAPU8,
      malloc: (size) => pdfiumModule.pdfium.wasmExports.malloc(size),
      free: (ptr) => pdfiumModule.pdfium.wasmExports.free(ptr),
    },
    PDFiumExt_Init: () => pdfiumModule.PDFiumExt_Init(),
    FPDF_GetLastError: () => pdfiumModule.FPDF_GetLastError(),
    FPDF_LoadMemDocument64: (p, s, pw) => pdfiumModule.FPDF_LoadMemDocument64(p, s, pw),
    FPDF_CloseDocument: (doc) => pdfiumModule.FPDF_CloseDocument(doc),
    FPDF_GetPageCount: (doc) => pdfiumModule.FPDF_GetPageCount(doc),
    FPDF_LoadPage: (doc, i) => pdfiumModule.FPDF_LoadPage(doc, i),
    FPDF_ClosePage: (page) => pdfiumModule.FPDF_ClosePage(page),
    FPDF_GetPageWidthF: (page) => pdfiumModule.FPDF_GetPageWidthF(page),
    FPDF_GetPageHeightF: (page) => pdfiumModule.FPDF_GetPageHeightF(page),
    FPDFBitmap_Create: (w, h, a) => pdfiumModule.FPDFBitmap_Create(w, h, a),
    FPDFBitmap_FillRect: (b, l, t, w, h, c) => pdfiumModule.FPDFBitmap_FillRect(b, l, t, w, h, c),
    FPDFBitmap_GetBuffer: (b) => pdfiumModule.FPDFBitmap_GetBuffer(b),
    FPDFBitmap_GetStride: (b) => pdfiumModule.FPDFBitmap_GetStride(b),
    FPDFBitmap_Destroy: (b) => pdfiumModule.FPDFBitmap_Destroy(b),
    FPDF_RenderPageBitmap: (b, p, x, y, sx, sy, r, f) =>
      pdfiumModule.FPDF_RenderPageBitmap(b, p, x, y, sx, sy, r, f),
  };

  return { jpeg, png, webp, resize, pdfium };
}
