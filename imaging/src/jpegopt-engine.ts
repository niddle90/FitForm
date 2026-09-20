/**
 * jpegopt-engine — the native, WASM-compiled compression core.
 *
 * This wraps native/jpegopt-fast-core (vendored source + build recipe in
 * this repo; compiled artifact shipped at wasm/jpegopt.{js,wasm}). Unlike
 * every other codec in this suite (jpeg/png/webp/resize/pdfium — see
 * codecs.ts), this one WASN'T sourced as an existing, pinned,
 * community-maintained build. It's the one deliberate exception to that
 * rule, made for reasons specific to compress:
 *
 *   - It's tiny in scope: libjpeg-turbo plus ~450 lines of C that do one
 *     job (encode-and-measure bisection on a real byte budget) — a much
 *     smaller trust surface than "vendor a general-purpose image library."
 *   - It reproduces xpress.c's original algorithm exactly (the same
 *     encode-and-measure bisection compress.ts's canvas path approximates
 *     via a browser's own JPEG encoder), so results are deterministic and
 *     platform-independent — the canvas path can't offer that, by design,
 *     because it depends on whichever JPEG encoder the host browser ships.
 *   - It's been verified byte-for-byte identical against a native
 *     (non-WASM) build of the same source across every option this module
 *     exposes — see scripts/build-wasm.sh's "Verifying a build" section
 *     for the exact reproduction steps.
 *
 * compress.ts's canvas path (browserCanvasProvider / nodeCanvasProvider)
 * still exists and is still the right choice for non-JPEG input, or for
 * consumers who'd rather not add a WASM asset to their bundle at all. See
 * README.md "Choosing an engine" for the tradeoffs.
 *
 * ---------------------------------------------------------------------
 * Design note — why every loader in this file demands `wasmBinary` up
 * front instead of letting the glue code fetch it:
 *
 * Emscripten's generated glue decides how to obtain the .wasm bytes by
 * feature-sniffing the environment: if a global `fetch` exists, it
 * assumes a browser/worker and tries `fetch(wasmBinaryFile)` — even under
 * Node, where `wasmBinaryFile` is a bare filename, not a URL. This was
 * harmless for years because Node had no global `fetch`; it stopped being
 * harmless once Node 18+ shipped one. The result under modern Node,
 * un-worked-around: a same-directory `fetch('jpegopt.wasm')` throws
 * `TypeError: Failed to parse URL`, not a helpful "you're in Node" error.
 *
 * The fix isn't to patch the glue (that's re-solving an upstream
 * Emscripten fix on every rebuild). It's to never let that code path run
 * at all: every one of Emscripten's loader branches is gated behind
 * `!wasmBinary && ...`, so supplying `wasmBinary` up front — bytes we
 * fetched ourselves in the browser, or read ourselves via `fs` in Node —
 * short-circuits the sniffing entirely. This is also exactly the pattern
 * codecs.ts's jSquash/pdfium wiring already uses (browser-codecs.ts,
 * node-codecs.ts both pass `wasmBinary` explicitly), so this engine
 * follows established precedent rather than inventing a new one.
 */

import createJpegOptModule, { type JpegOptWasmModule } from '../wasm/jpegopt.js';

export type SubsamplingMode = '4:4:4' | '4:2:2' | '4:2:0' | '4:1:1';
export type CropAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right';

const SUBSAMPLING_CODES: Record<SubsamplingMode, number> = {
  '4:4:4': 0,
  '4:2:2': 1,
  '4:2:0': 2,
  '4:1:1': 3,
};

const CROP_ANCHOR_CODES: Record<CropAnchor, number> = {
  center: 0,
  top: 1,
  bottom: 2,
  left: 3,
  right: 4,
};

export interface JpegOptRunOptions {
  /** Target output size, in binary kilobytes (KiB). */
  targetKb: number;

  /** See the module-level dimension-handling comment in jpegopt.c. */
  width?: number;
  height?: number;
  /** Keep the source's native pixel size; ignore width/height entirely. */
  fixedDimension?: boolean;

  /**
   * Quality floor the bisection won't go below before instead shrinking
   * pixels (only relevant when dimensions aren't pinned). 1-100, default
   * 20 — matches the original engine's hardcoded value.
   */
  minQuality?: number;

  /**
   * How many shrink-and-retry rounds the autoscale fallback gets when
   * even `minQuality` doesn't fit the budget. Default 5.
   */
  maxScaleTries?: number;

  /**
   * Chroma subsampling. Default '4:4:4' — matches the original engine
   * (no subsampling at all, maximum color fidelity). Lower ratios trade
   * color detail for smaller files at a fixed quality.
   */
  subsampling?: SubsamplingMode;

  /**
   * Emit a progressive (multi-scan) JPEG instead of baseline sequential.
   * Default false — matches the original engine.
   */
  progressive?: boolean;

  /**
   * For the `width` + `height` "cover" mode only: which part of the
   * overflow to keep after the crop. Default 'center' — matches the
   * original engine.
   */
  cropAnchor?: CropAnchor;
}

export interface JpegOptResult {
  data: Uint8Array;
  /** The JPEG quality (1-100) the bisection settled on. */
  quality: number;
  /** Final pixel dimensions actually encoded, after any resize/crop. */
  width: number;
  height: number;
  /**
   * false only if the budget genuinely couldn't be hit even at
   * `minQuality` and (when autoscale was allowed) the smallest size the
   * scale-tries budget reached. The result is still a valid, complete
   * JPEG in that case — this just tells you the byte budget was missed.
   */
  metTarget: boolean;
}

export interface JpegOptEngine {
  /**
   * Synchronous by design — once the WASM module is loaded, every call
   * runs to completion in one JS turn (no internal yielding), so there's
   * no reentrancy hazard to design around. Each engine instance owns one
   * WASM memory arena; reuse one instance across as many sequential
   * `run()` calls as you like. For parallelism, create one instance per
   * Web/Worker thread — WASM instances aren't shared across threads here
   * (no SharedArrayBuffer / pthreads in this build; see
   * native/jpegopt-fast-core's own README for why that's a deliberate
   * simplicity tradeoff, not an oversight).
   *
   * Returns `null` (never throws) when the input can't be decoded as a
   * JPEG — mirrors libjpeg's own error path, caught internally via
   * `setjmp`/`longjmp` rather than crashing the WASM instance. Argument
   * validation errors (e.g. a non-positive `targetKb`) throw a plain
   * `RangeError` instead, since those are programmer errors, not data
   * problems — compress.ts is what translates both into the suite's
   * `VaultError` taxonomy for callers of the tool-level API.
   */
  run(input: Uint8Array, options: JpegOptRunOptions): JpegOptResult | null;
}

/**
 * The one function every environment-specific loader in this suite
 * (createJpegOptEngineBrowser in browser.ts, createJpegOptEngineNode in
 * node.ts) ultimately calls. Exported directly too, for anyone who
 * already has the wasm bytes some other way (a bundler's `?url` import, a
 * Worker's `postMessage`d ArrayBuffer, etc).
 */
export async function createJpegOptEngineFromBinary(
  wasmBinary: Uint8Array | ArrayBuffer,
): Promise<JpegOptEngine> {
  const mod: JpegOptWasmModule = await createJpegOptModule({ wasmBinary });

  const runEx = mod.cwrap<number[], number>('jpegopt_wasm_run_ex', 'number', new Array(11).fill('number'));
  const lastLen = mod.cwrap<[], number>('jpegopt_wasm_last_len', 'number', []);
  const lastQuality = mod.cwrap<[], number>('jpegopt_wasm_last_quality', 'number', []);
  const lastWidth = mod.cwrap<[], number>('jpegopt_wasm_last_width', 'number', []);
  const lastHeight = mod.cwrap<[], number>('jpegopt_wasm_last_height', 'number', []);
  const lastMetTarget = mod.cwrap<[], number>('jpegopt_wasm_last_met_target', 'number', []);

  return {
    run(input, options): JpegOptResult | null {
      if (!Number.isFinite(options.targetKb) || options.targetKb <= 0) {
        throw new RangeError('jpegopt: targetKb must be a positive number');
      }

      const inPtr = mod._jpegopt_wasm_alloc(input.byteLength);
      if (!inPtr) {
        throw new Error('jpegopt: out of WASM memory allocating the input buffer');
      }

      try {
        // Re-read HEAPU8 off `mod` (never cache it) — ALLOW_MEMORY_GROWTH
        // means a prior call may have grown the WASM heap, which detaches
        // any typed-array view captured over the old buffer. Same hazard
        // codecs.ts documents for pdfium's heap.
        mod.HEAPU8.set(input, inPtr);

        const outPtr = runEx(
          inPtr,
          input.byteLength,
          Math.floor(options.targetKb),
          options.width ?? 0,
          options.height ?? 0,
          options.fixedDimension ? 1 : 0,
          options.minQuality ?? 0,
          options.maxScaleTries ?? 0,
          SUBSAMPLING_CODES[options.subsampling ?? '4:4:4'],
          options.progressive ? 1 : 0,
          CROP_ANCHOR_CODES[options.cropAnchor ?? 'center'],
        );

        if (!outPtr) return null; // decode failure -- not a valid jpeg

        const len = lastLen();
        // Copy out of WASM memory before freeing the C-side result on the
        // next call/GC — the same "never hand back a live view" rule as
        // pdfium's FPDFBitmap_GetBuffer usage elsewhere in this suite.
        const data = mod.HEAPU8.slice(outPtr, outPtr + len);

        return {
          data,
          quality: lastQuality(),
          width: lastWidth(),
          height: lastHeight(),
          metTarget: !!lastMetTarget(),
        };
      } finally {
        mod._jpegopt_wasm_free(inPtr);
      }
    },
  };
}
