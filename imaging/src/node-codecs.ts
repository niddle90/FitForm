/**
 * Node.js codec wiring: `createNodeCodecs()` implements the same
 * `VaultCodecs` contract as `./browser-codecs.js`, so every algorithm in
 * this package (compress, printLayout, convertFormat, pdfToImages) runs unmodified in
 * Node.
 *
 * jSquash's own docs describe their Node support as "limited/
 * experimental" — their default `init()` paths try to `fetch()` a
 * same-directory wasm URL, which doesn't resolve under plain Node
 * execution. Passing each codec's `init()` an explicit `wasmBinary` read
 * via `fs.readFileSync` sidesteps that; this exact pattern is exercised
 * by this package's own test suite against the real pinned wasm binaries,
 * not just asserted to work.
 *
 * Import from 'imaging/node', not from the package root -- keeping
 * this out of the root barrel means a browser bundle never has a reason
 * to try to resolve `node:fs`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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
  VaultCodecs,
  JpegCodec,
  PngCodec,
  WebpCodec,
  ResizeCodec,
  PdfiumBinding,
} from './codecs.js';

const require = createRequire(import.meta.url);

function wasmPath(spec: string): string {
  return require.resolve(spec);
}

export async function createNodeCodecs(): Promise<Required<VaultCodecs>> {
  await jpegDecodeMod.init({ wasmBinary: readFileSync(wasmPath('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')) });
  await jpegEncodeMod.init({ wasmBinary: readFileSync(wasmPath('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm')) });
  const jpeg: JpegCodec = {
    decode: (buf) => decodeJpeg(buf),
    encode: (data, options) => encodeJpeg(data, options),
  };

  const pngWasm = readFileSync(wasmPath('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
  await pngEncodeMod.init(pngWasm);
  await pngDecodeMod.init(pngWasm);
  const png: PngCodec = {
    decode: (buf) => decodePng(buf),
    encode: (data) => encodePng(data),
  };

  await webpDecodeMod.init({ wasmBinary: readFileSync(wasmPath('@jsquash/webp/codec/dec/webp_dec.wasm')) });
  await webpEncodeMod.init({ wasmBinary: readFileSync(wasmPath('@jsquash/webp/codec/enc/webp_enc.wasm')) });
  const webp: WebpCodec = {
    decode: (buf) => decodeWebp(buf),
    encode: (data, options) => encodeWebp(data, options),
  };

  await initResize(readFileSync(wasmPath('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm')));
  const resize: ResizeCodec = {
    resize: (data, options) =>
      resizeImage(data, { ...options, fitMethod: 'stretch', premultiply: true, linearRGB: false }),
  };

  const pdfiumWasmBinary = readFileSync(wasmPath('@embedpdf/pdfium/pdfium.wasm'));
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
