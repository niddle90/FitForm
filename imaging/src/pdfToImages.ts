/**
 * pdfToImages — extract one or all pages from a PDF as JPEG images.
 * Browser port of xpeel.c.
 *
 * Unaffected by the tolerance discussion (migration_v3.md §2.5): there is
 * no Web API that interprets PDF content streams, so this was never a
 * candidate for a native/WASM choice — `@embedpdf/pdfium` is required
 * regardless of what any perceptual threshold says, because there's no
 * native side to compare it against.
 *
 * migration_v2.md §4.2 flagged the `fz_*` → `FPDF_*` API mapping as
 * "not yet done — see §8". This file is that mapping. Every call below
 * (FPDF_LoadMemDocument64, FPDF_GetPageWidthF/HeightF, FPDFBitmap_Create
 * with alpha=0, FPDFBitmap_FillRect, FPDF_RenderPageBitmap,
 * FPDFBitmap_GetStride/GetBuffer) was exercised against the real, pinned
 * `@embedpdf/pdfium@2.15.0` binary — decode a real PDF, render a page,
 * sample pixels — before being written here; see README.md's
 * "Validated against the real package" section. Two things confirmed
 * empirically, not assumed from documentation:
 *   1. `FPDFBitmap_Create(w, h, 0)` yields BGRx (blue, green, red, unused),
 *      not RGBA — the R/B swap in `bgrxRowToRgba()` below is required.
 *   2. The buffer must be filled white via `FPDFBitmap_FillRect` before
 *      rendering, or transparent/uninitialized memory shows through
 *      wherever the page doesn't paint — mirrors xpeel.c's implicit
 *      white-background page image via `fz_device_rgb` with no alpha.
 */

import type { JpegCodec, PdfiumBinding } from './codecs.js';
import { VaultError, silentLogger, type Logger } from './errors.js';
import { makeImageData } from './image-data.js';

const TARGET_DIM = 4000.0;
const FPDF_ANNOT = 0x01; // render annotations too — parity with how a viewer (and MuPDF, by default) shows a page

/**
 * Hard ceiling on the long side of a rendered page bitmap, independent of
 * TARGET_DIM. A PDF's MediaBox is attacker-controlled the moment the PDF
 * itself is: nothing in the spec (or in pdfium) stops a page from
 * declaring e.g. a 20000x20000pt box. Without this cap, `zoom` is only
 * ever adjusted *up* to hit TARGET_DIM on small pages (the `if (zoom < 1)
 * zoom = 1` below refuses to *downscale*), so an oversized MediaBox is
 * rendered 1:1 — a few hundred bytes of PDF can then force a
 * multi-gigabyte `FPDFBitmap_Create` call. Confirmed by hand: a 20000x20000pt
 * one-page PDF here reliably gets the process OOM-killed with this cap
 * absent. MAX_RENDER_DIM caps that, at the cost of downscaling genuinely
 * huge pages below TARGET_DIM's target quality.
 */
const MAX_RENDER_DIM = 8000;

export interface PdfToImagesOptions {
  /** Extract this page only (1-based). Omit to extract every page. */
  page?: number;
  /** JPEG quality 1-100. Default 85 (matches xpeel.c's default). */
  quality?: number;
  /**
   * Ceiling on the long side of any rendered page, in pixels. Default
   * `MAX_RENDER_DIM` (8000). Exists so a page with a hostile/malformed
   * MediaBox can't force an unbounded bitmap allocation — see
   * MAX_RENDER_DIM's comment. Override only if you specifically need to
   * render larger pages and have already sized your memory budget for it.
   */
  maxRenderDim?: number;
  verbose?: boolean;
  onLog?: Logger;
}

export interface PdfToImagesCodecs {
  jpeg: JpegCodec;
  pdfium: PdfiumBinding;
}

export interface PdfToImagesPage {
  /** 1-based page number, matching xpeel.c's --page numbering. */
  pageNumber: number;
  jpeg: Uint8Array;
}

function bgrxBufferToImageData(
  heap: Uint8Array,
  bufPtr: number,
  width: number,
  height: number,
  stride: number,
): ImageData {
  const out = makeImageData(width, height);
  for (let y = 0; y < height; y++) {
    const rowStart = bufPtr + y * stride;
    for (let x = 0; x < width; x++) {
      const sIdx = rowStart + x * 4;
      const dIdx = (y * width + x) * 4;
      out.data[dIdx] = heap[sIdx + 2]!; // R (source is B,G,R,x)
      out.data[dIdx + 1] = heap[sIdx + 1]!; // G
      out.data[dIdx + 2] = heap[sIdx]!; // B
      out.data[dIdx + 3] = 255;
    }
  }
  return out;
}

export async function pdfToImages(
  input: Uint8Array,
  codecs: PdfToImagesCodecs,
  options: PdfToImagesOptions = {},
): Promise<PdfToImagesPage[]> {
  const TOOL = 'pdfToImages';
  const log =
    options.onLog ?? (options.verbose ? (m: string) => console.error(`[pdfToImages] ${m}`) : silentLogger);
  const pdfium = codecs.pdfium;

  const quality = options.quality ?? 85;
  if (quality < 1 || quality > 100) {
    throw new VaultError(TOOL, 'ARGS', 'quality must be between 1 and 100');
  }
  if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1)) {
    throw new VaultError(TOOL, 'ARGS', 'page must be a positive integer');
  }
  const maxRenderDim = options.maxRenderDim ?? MAX_RENDER_DIM;
  if (!Number.isFinite(maxRenderDim) || maxRenderDim < 1) {
    throw new VaultError(TOOL, 'ARGS', 'maxRenderDim must be a positive number');
  }

  const ptr = pdfium.heap.malloc(input.length);
  if (!ptr) throw new VaultError(TOOL, 'MEMORY', 'out of memory loading pdf into wasm heap');
  pdfium.heap.getHEAPU8().set(input, ptr);

  let doc = 0;
  try {
    doc = pdfium.FPDF_LoadMemDocument64(ptr, input.length, '');
    if (!doc) {
      throw new VaultError(
        TOOL,
        'FORMAT',
        `cannot parse input as pdf (pdfium error ${pdfium.FPDF_GetLastError()})`,
      );
    }

    const totalPages = pdfium.FPDF_GetPageCount(doc);
    log(`info: document has ${totalPages} page${totalPages === 1 ? '' : 's'}`);

    const requestedIndex = options.page !== undefined ? options.page - 1 : null;
    if (requestedIndex !== null && requestedIndex >= totalPages) {
      throw new VaultError(
        TOOL,
        'ARGS',
        `page ${options.page} requested but document has only ${totalPages} page${totalPages === 1 ? '' : 's'}`,
      );
    }

    const start = requestedIndex ?? 0;
    const end = requestedIndex ?? totalPages - 1;

    const results: PdfToImagesPage[] = [];
    for (let pageIndex = start; pageIndex <= end; pageIndex++) {
      let page = 0;
      let bitmap = 0;
      try {
        page = pdfium.FPDF_LoadPage(doc, pageIndex);
        if (!page) {
          throw new VaultError(TOOL, 'IO', `failed to render page ${pageIndex + 1}`);
        }

        const w = pdfium.FPDF_GetPageWidthF(page);
        const h = pdfium.FPDF_GetPageHeightF(page);
        const mx = Math.max(w, h);
        let zoom = mx > 0 ? TARGET_DIM / mx : 1;
        if (zoom < 1) zoom = 1;
        // Cap the *result*, not just the upscale factor: a page whose
        // native size already exceeds maxRenderDim must still be clamped
        // even though zoom itself was never increased for it (see
        // MAX_RENDER_DIM's comment — this is the line that actually closes
        // the hole, not the zoom<1 guard above, which only ever prevents
        // downscaling small pages, never large ones).
        if (mx > 0 && mx * zoom > maxRenderDim) {
          zoom = maxRenderDim / mx;
        }
        const outW = Math.max(1, Math.round(w * zoom));
        const outH = Math.max(1, Math.round(h * zoom));

        bitmap = pdfium.FPDFBitmap_Create(outW, outH, 0); // BGRx, opaque
        if (!bitmap) throw new VaultError(TOOL, 'MEMORY', 'failed to allocate render bitmap');

        pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, outW, outH, 0xffffffff); // white background
        pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, outW, outH, 0, FPDF_ANNOT);

        log(`info: page ${pageIndex + 1} rendered at ${outW}x${outH}`);

        const stride = pdfium.FPDFBitmap_GetStride(bitmap);
        const bufPtr = pdfium.FPDFBitmap_GetBuffer(bitmap);
        const imageData = bgrxBufferToImageData(pdfium.heap.getHEAPU8(), bufPtr, outW, outH, stride);

        const encoded = await codecs.jpeg.encode(imageData, { quality });
        results.push({ pageNumber: pageIndex + 1, jpeg: new Uint8Array(encoded) });
      } finally {
        if (bitmap) pdfium.FPDFBitmap_Destroy(bitmap);
        if (page) pdfium.FPDF_ClosePage(page);
      }
    }

    return results;
  } finally {
    if (doc) pdfium.FPDF_CloseDocument(doc);
    pdfium.heap.free(ptr);
  }
}
