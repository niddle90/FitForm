/**
 * Codec interfaces shared by printLayout, convertFormat, and pdfToImages.
 *
 * Per migration_v3.md, every one of these is backed by an existing,
 * pinned, community-maintained WASM build (the jSquash family + a
 * precompiled pdfium) — never a module this project compiles itself.
 * That line still holds for everything in this file. It was
 * deliberately redrawn *once*, for compress specifically, in the hybrid-
 * engine revision: see jpegopt-engine.ts's top comment for why that one
 * tool now optionally uses a small, self-built, byte-verified WASM core
 * alongside (not instead of) its original zero-WASM Canvas path. Nothing
 * below this comment changed as part of that — printLayout, convertFormat, and
 * pdfToImages are all still exactly "existing pinned build, never compiled
 * here."
 *
 * Tool modules (printLayout.ts, convert/index.ts, pdfToImages.ts) depend only on
 * these interfaces, not on `@jsquash/*` or `@embedpdf/pdfium` directly.
 * That's what lets browser-codecs.ts (real fetch-based wiring, for
 * production) and test/node-codecs.ts (fs-based wiring, for the smoke
 * suite) both satisfy the same contract without the tool logic caring
 * which one it got.
 */

export interface JpegCodec {
  decode(buffer: ArrayBuffer): Promise<ImageData>;
  encode(data: ImageData, options?: { quality?: number }): Promise<ArrayBuffer>;
}

export interface PngCodec {
  decode(buffer: ArrayBuffer): Promise<ImageData>;
  encode(data: ImageData): Promise<ArrayBuffer>;
}

export interface WebpCodec {
  decode(buffer: ArrayBuffer): Promise<ImageData>;
  encode(data: ImageData, options?: { quality?: number }): Promise<ArrayBuffer>;
}

export type ResizeMethod =
  | 'triangle'
  | 'catrom'
  | 'mitchell'
  | 'lanczos3'
  | 'hqx'
  | 'magicKernel'
  | 'magicKernelSharp2013'
  | 'magicKernelSharp2021';

export interface ResizeCodec {
  resize(
    data: ImageData,
    options: { width: number; height: number; method: ResizeMethod },
  ): Promise<ImageData>;
}

/**
 * Minimal surface of @embedpdf/pdfium's wrapped module actually needed by
 * pdfToImages.ts. This is intentionally narrow (not "the whole pdfium API") —
 * same "four API calls out of an enormous surface area" reasoning v1/v2
 * already applied to ImageMagick and jsPDF, aimed here at pdfium's much
 * larger surface.
 */
export interface PdfiumBinding {
  /**
   * Raw module + Emscripten runtime (HEAPU8, malloc/free, etc).
   *
   * `getHEAPU8()` is a function, not a cached property, on purpose: when
   * the WASM instance's memory grows (`WebAssembly.Memory.grow`), any
   * previously-captured typed-array view over it is detached — capturing
   * `HEAPU8` once at init time and reusing that reference across multiple
   * documents/pages throws "Cannot perform %TypedArray%.prototype.set on a
   * detached ArrayBuffer" the moment memory grows in between. Confirmed by
   * hitting exactly this in the smoke suite (test/run.ts) before this
   * comment was written — see README's "Validated against the real
   * package" note.
   */
  readonly heap: {
    getHEAPU8(): Uint8Array;
    malloc(size: number): number;
    free(ptr: number): void;
  };
  PDFiumExt_Init(): void;
  FPDF_GetLastError(): number;
  FPDF_LoadMemDocument64(dataPtr: number, size: number, password: string): number;
  FPDF_CloseDocument(doc: number): void;
  FPDF_GetPageCount(doc: number): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDF_GetPageWidthF(page: number): number;
  FPDF_GetPageHeightF(page: number): number;
  FPDFBitmap_Create(width: number, height: number, alpha: number): number;
  FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): boolean;
  FPDFBitmap_GetBuffer(bitmap: number): number;
  FPDFBitmap_GetStride(bitmap: number): number;
  FPDFBitmap_Destroy(bitmap: number): void;
  FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): void;
}

/** Everything a given tool might need, wired up once by the caller. */
export interface VaultCodecs {
  jpeg: JpegCodec;
  png?: PngCodec;
  webp?: WebpCodec;
  resize?: ResizeCodec;
  pdfium?: PdfiumBinding;
}
