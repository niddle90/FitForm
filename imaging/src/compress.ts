/**
 * compress — compress an image to a target file size in KB.
 *
 * This is the suite's hybrid tool: two independent engines, one contract
 * ("final size ≤ target, or a clean CONSTRAINT error"). Pick one, or let
 * `engine: 'auto'` (the default) choose:
 *
 *   'canvas'  The original browser port of xpress.c. Ships ZERO WASM.
 *             Works on any input a canvas can decode (JPEG, PNG, WebP,
 *             GIF, ...). Bisects on the *actual* encoded blob.size on
 *             every iteration, so it's correct-by-construction on
 *             whatever encoder the host happens to ship — see the
 *             "Known, accepted consequence" note below for the one
 *             tradeoff that comes with that.
 *
 *   'wasm'    The jpegopt native engine (see jpegopt-engine.ts). JPEG
 *             input only. Deterministic and platform-independent — the
 *             same input+options produce the same output bytes on every
 *             browser and every OS, verified byte-for-byte against a
 *             native (non-WASM) build in this repo's own test suite.
 *             Faster (libjpeg-turbo directly, no canvas round-trip) and
 *             exposes controls the canvas path has no way to offer:
 *             explicit output dimensions with an anchored crop, chroma
 *             subsampling, progressive encoding, a configurable quality
 *             floor, and an autoscale-retry budget. Requires a
 *             `wasmEngine` (see createJpegOptEngineBrowser/Node).
 *
 *   'auto'    Use 'wasm' if a `wasmEngine` was supplied AND the input
 *             looks like a JPEG (magic bytes FF D8); otherwise 'canvas'.
 *             This is the default specifically so that dropping a
 *             `wasmEngine` into existing code upgrades JPEG-in/JPEG-out
 *             calls to the faster, deterministic path with no other
 *             change, while non-JPEG input keeps working exactly as
 *             before through the canvas path.
 *
 * Why the canvas engine needed no codec library at all: xpress.c's binary
 * search never assumed a fixed quality→size curve — it encodes a
 * candidate quality, measures the *actual resulting file* with
 * get_size_kb(), and adjusts its search bounds from that measurement,
 * every iteration. That makes it encoder-agnostic by construction. Port
 * the same loop against `canvas.convertToBlob()` / `OffscreenCanvas`,
 * read `blob.size` in place of get_size_kb(), and the contract ("final
 * size ≤ target") holds on every browser by construction, because it's
 * re-verified against real output at runtime on every client — not
 * assumed from a table. See v2_discussion.md and migration_v3.md §2.1 for
 * the full reasoning trail.
 *
 * Known, accepted consequence of the canvas engine (flagged explicitly in
 * migration_v3.md §2.1, not silently absorbed): if one browser's JPEG
 * encoder needs more bytes than another's for the same visual quality,
 * its downscale fallback may bottom out at a different width than
 * another browser's for the *same* input + target. Two browsers can
 * therefore return different pixel dimensions for identical input — never
 * a different final byte budget. The wasm engine doesn't have this
 * tradeoff (same libjpeg-turbo build everywhere), which is the other half
 * of why it's worth the WASM weight for JPEG-in/JPEG-out use.
 */

import { VaultError, silentLogger, type Logger } from './errors.js';
import { parseJpegMeta } from './jpegsToPdf.js';
import type {
  JpegOptEngine,
  JpegOptResult,
  SubsamplingMode,
  CropAnchor,
} from './jpegopt-engine.js';

/** A decoded, drawable image handle — an ImageBitmap in real browser use. */
export interface DecodedBitmap {
  readonly width: number;
  readonly height: number;
}

/**
 * Everything compress's canvas engine needs from "the canvas". Abstracted
 * so the algorithm can be exercised outside a real browser (see
 * test/node-canvas-provider.ts, backed by @napi-rs/canvas) — production
 * code should just use `browserCanvasProvider`, the real, dependency-free
 * path.
 */
export interface CanvasProvider {
  decodeToBitmap(bytes: Uint8Array): Promise<DecodedBitmap>;
  /**
   * Draw `bitmap` scaled to `width`x`height` and encode as JPEG.
   * `quality` is a 0..1 float, canvas-style (0 = worst, 1 = best).
   */
  renderJpeg(
    bitmap: DecodedBitmap,
    width: number,
    height: number,
    quality: number,
  ): Promise<Uint8Array>;
}

/** Real, native, zero-dependency browser implementation. */
export const browserCanvasProvider: CanvasProvider = {
  async decodeToBitmap(bytes) {
    const blob = new Blob([bytes]);
    return await createImageBitmap(blob);
  },
  async renderJpeg(bitmap, width, height, quality) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('failed to acquire 2d canvas context');
    ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
};

export type CompressEngine = 'auto' | 'wasm' | 'canvas';

export interface CompressOptions {
  /** Target output size, in binary kilobytes (KiB) — matches xpress.c's --target-kb. */
  targetKb: number;
  verbose?: boolean;
  onLog?: Logger;

  /** Which engine to use. Default 'auto' — see the module comment above. */
  engine?: CompressEngine;

  /**
   * Resolve to `{ data, engine, width, height, quality?, metTarget? }`
   * instead of a bare `Uint8Array`. Default false, so existing callers
   * that treat compress's return value as raw bytes are unaffected. Same
   * convention `sharp` uses for its own `resolveWithObject`.
   */
  resolveWithObject?: boolean;

  // ── canvas engine ──────────────────────────────────────────────────
  /** Defaults to `browserCanvasProvider`; override only for testing. */
  canvasProvider?: CanvasProvider;

  // ── wasm engine ────────────────────────────────────────────────────
  /** Required for `engine: 'wasm'`; silently unused by 'canvas'. */
  wasmEngine?: JpegOptEngine;
  /** See jpegopt-engine.ts's JpegOptRunOptions for full docs on these. */
  width?: number;
  height?: number;
  fixedDimension?: boolean;
  minQuality?: number;
  maxScaleTries?: number;
  subsampling?: SubsamplingMode;
  progressive?: boolean;
  cropAnchor?: CropAnchor;
  /**
   * If the wasm engine can't hit `targetKb` even at `minQuality` (and,
   * when dimensions weren't pinned, even after `maxScaleTries` shrink
   * rounds), the default is to throw `VaultError('CONSTRAINT', ...)` —
   * matching the canvas engine's uncompromising "final size ≤ target, or
   * a clean error" contract. Set `allowMiss: true` to instead get the
   * closest result back (check `metTarget` in the resolved object to see
   * whether it actually hit the budget).
   */
  allowMiss?: boolean;
}

export interface CompressResultInfo {
  engine: 'wasm' | 'canvas';
  width: number;
  height: number;
  /** wasm engine only. */
  quality?: number;
  /** wasm engine only — always true for the canvas engine, which never returns a miss (see allowMiss). */
  metTarget?: boolean;
}

const QSCALE_MIN = 1; // best quality, mirrors ffmpeg's -q:v mjpeg scale
const QSCALE_MAX = 31; // worst quality

function qscaleToCanvasQuality(q: number): number {
  return 1 - (q - QSCALE_MIN) / (QSCALE_MAX - QSCALE_MIN);
}

function looksLikeJpeg(input: Uint8Array): boolean {
  return input.length >= 2 && input[0] === 0xff && input[1] === 0xd8;
}

export async function compress(
  input: Uint8Array,
  options: CompressOptions & { resolveWithObject: true },
): Promise<{ data: Uint8Array } & CompressResultInfo>;
export async function compress(input: Uint8Array, options: CompressOptions): Promise<Uint8Array>;
export async function compress(
  input: Uint8Array,
  options: CompressOptions,
): Promise<Uint8Array | ({ data: Uint8Array } & CompressResultInfo)> {
  const TOOL = 'compress';
  const log =
    options.onLog ?? (options.verbose ? (m: string) => console.error(`[compress] ${m}`) : silentLogger);

  if (!Number.isFinite(options.targetKb) || options.targetKb <= 0) {
    throw new VaultError(TOOL, 'ARGS', '--target-kb is required and must be a positive integer');
  }
  const targetKb = Math.floor(options.targetKb);

  const requestedEngine = options.engine ?? 'auto';
  if (requestedEngine === 'wasm' && !options.wasmEngine) {
    throw new VaultError(TOOL, 'ARGS', "engine: 'wasm' requires a wasmEngine (see createJpegOptEngineBrowser/Node)");
  }
  const useWasm =
    requestedEngine === 'wasm' ||
    (requestedEngine === 'auto' && !!options.wasmEngine && looksLikeJpeg(input));

  function finalize(data: Uint8Array, info: CompressResultInfo): Uint8Array | ({ data: Uint8Array } & CompressResultInfo) {
    return options.resolveWithObject ? { data, ...info } : data;
  }

  // get_size_kb() in xpress.c is integer bytes/1024 truncation, which the
  // bisection loop below still mirrors for its own search granularity
  // (that KB-level search behavior is inherited intentionally — see the
  // module comment). This early "already within budget" exit is
  // different: it's a yes/no gate against the caller's literal
  // byte-length promise, not part of the search, so it compares exact
  // bytes rather than double-truncated KB (truncating both sides here let
  // an input up to ~1 KB over budget slip through as "already fine" —
  // e.g. a 500.9 KB input against a 500 KB target).
  const targetBytes = targetKb * 1024;
  const wantsExplicitDimensions = useWasm && (!!options.width || !!options.height);
  if (input.byteLength <= targetBytes && !wantsExplicitDimensions) {
    const currentKb = Math.floor(input.byteLength / 1024);
    log(`info: input already within target (${currentKb}kb <= ${targetKb}kb), copying`);
    const meta = looksLikeJpeg(input) ? parseJpegMeta(input) : null;
    return finalize(input, {
      engine: useWasm ? 'wasm' : 'canvas',
      width: meta?.w ?? 0,
      height: meta?.h ?? 0,
      metTarget: true,
    });
  }

  if (useWasm) {
    return runWasmEngine(TOOL, input, targetKb, options, log, finalize);
  }
  return runCanvasEngine(TOOL, input, targetKb, options, log, finalize);
}

// ────────────────────────────────────────────────────────────────────────
// wasm engine
// ────────────────────────────────────────────────────────────────────────

async function runWasmEngine(
  TOOL: string,
  input: Uint8Array,
  targetKb: number,
  options: CompressOptions,
  log: Logger,
  finalize: (data: Uint8Array, info: CompressResultInfo) => Uint8Array | ({ data: Uint8Array } & CompressResultInfo),
): Promise<Uint8Array | ({ data: Uint8Array } & CompressResultInfo)> {
  const engine = options.wasmEngine!;

  let result: JpegOptResult | null;
  try {
    result = engine.run(input, {
      targetKb,
      width: options.width,
      height: options.height,
      fixedDimension: options.fixedDimension,
      minQuality: options.minQuality,
      maxScaleTries: options.maxScaleTries,
      subsampling: options.subsampling,
      progressive: options.progressive,
      cropAnchor: options.cropAnchor,
    });
  } catch (e) {
    // RangeError from jpegopt-engine.ts's own argument validation is a
    // programmer error at the tool boundary, not a data problem — surface
    // it as ARGS rather than letting a raw RangeError escape the
    // suite's categorized-error contract (see errors.ts).
    const detail = e instanceof Error ? e.message : String(e);
    throw new VaultError(TOOL, 'ARGS', detail);
  }

  if (!result) {
    throw new VaultError(TOOL, 'FORMAT', 'cannot decode input as jpeg (the wasm engine only accepts jpeg input)');
  }

  log(
    `info: [wasm] ${result.width}x${result.height} q=${result.quality} ` +
      `${Math.round(result.data.length / 1024)}kb met=${result.metTarget}`,
  );

  if (!result.metTarget && !options.allowMiss) {
    throw new VaultError(
      TOOL,
      'CONSTRAINT',
      `cannot reach ${targetKb}kb even at the configured quality floor` +
        (options.fixedDimension || options.width || options.height
          ? ' (dimensions were pinned, so no autoscale fallback was available)'
          : ' after exhausting the autoscale retry budget') +
        ` — closest achieved was ${Math.round(result.data.length / 1024)}kb at quality ${result.quality}` +
        '; pass allowMiss: true to accept the closest result instead of throwing',
    );
  }

  return finalize(result.data, {
    engine: 'wasm',
    width: result.width,
    height: result.height,
    quality: result.quality,
    metTarget: result.metTarget,
  });
}

// ────────────────────────────────────────────────────────────────────────
// canvas engine (unchanged algorithm from the original single-engine compress)
// ────────────────────────────────────────────────────────────────────────

async function runCanvasEngine(
  TOOL: string,
  input: Uint8Array,
  targetKb: number,
  options: CompressOptions,
  log: Logger,
  finalize: (data: Uint8Array, info: CompressResultInfo) => Uint8Array | ({ data: Uint8Array } & CompressResultInfo),
): Promise<Uint8Array | ({ data: Uint8Array } & CompressResultInfo)> {
  const provider = options.canvasProvider ?? browserCanvasProvider;

  let bitmap: DecodedBitmap;
  try {
    bitmap = await provider.decodeToBitmap(input);
  } catch (e) {
    // createImageBitmap (the real browserCanvasProvider's implementation)
    // rejects with a plain DOMException on invalid/corrupt image bytes —
    // that's not a VaultError, so left unwrapped it would leak past the
    // categorized-error contract every other tool in this suite honors
    // (see errors.ts). Re-throw it as one, preserving the original message.
    const detail = e instanceof Error ? e.message : String(e);
    throw new VaultError(TOOL, 'FORMAT', `cannot decode input image: ${detail}`);
  }
  const origW = bitmap.width;
  const origH = bitmap.height;
  if (!origW || !origH) {
    throw new VaultError(TOOL, 'FORMAT', 'cannot determine image dimensions');
  }

  async function encodeAt(width: number, qscale: number): Promise<Uint8Array> {
    const height = Math.max(1, Math.round((width / origW) * origH));
    return provider.renderJpeg(bitmap, width, height, qscaleToCanvasQuality(qscale));
  }

  // Pass 1: worst-quality probe at full width — is scaling needed at all?
  let targetW = origW;
  let probe = await encodeAt(targetW, QSCALE_MAX);
  let minQSizeKb = probe.byteLength / 1024;

  if (minQSizeKb > targetKb) {
    log(`info: minimum achievable size at q${QSCALE_MAX} is ${Math.round(minQSizeKb)}kb; scaling down`);
  }

  // Iterative scale-down: identical formula to xpress.c (0.90 safety margin,
  // 0.85 fallback when the ratio alone wouldn't shrink anything).
  while (minQSizeKb > targetKb && targetW > 1) {
    const ratio = targetKb / minQSizeKb;
    let scale = Math.sqrt(ratio) * 0.9;
    if (scale >= 1.0) scale = 0.85;
    let newW = Math.floor(targetW * scale);
    if (newW < 1) newW = 1;
    if (newW >= targetW) newW = targetW - 1;
    targetW = newW;

    probe = await encodeAt(targetW, QSCALE_MAX);
    minQSizeKb = probe.byteLength / 1024;
    log(`info: scale probe w=${targetW} -> ${Math.round(minQSizeKb)}kb`);
  }

  if (minQSizeKb > targetKb && targetW <= 1) {
    throw new VaultError(
      TOOL,
      'CONSTRAINT',
      `cannot reach ${targetKb}kb even at minimum width and lowest quality`,
    );
  }

  // Binary search for quality — same 6-round bisection as xpress.c.
  let low = QSCALE_MIN;
  let high = QSCALE_MAX;
  let best = QSCALE_MAX;
  let bestBytes: Uint8Array = probe;
  for (let i = 0; i < 6 && low <= high; i++) {
    const mid = low + Math.floor((high - low) / 2);
    const candidate = await encodeAt(targetW, mid);
    const sizeKb = candidate.byteLength / 1024;
    log(`info: bisect q=${mid} -> ${Math.round(sizeKb)}kb`);
    if (sizeKb > targetKb) {
      low = mid + 1;
    } else {
      best = mid;
      bestBytes = candidate;
      high = mid - 1;
    }
  }

  // Post-encode size cap, replacing jpegoptim's role (migration_v3.md §2.1).
  // xpress.c: jpegoptim_kb = floor(target_kb * 1024 / 1000) - 2, then
  // jpegoptim enforces the file stays within jpegoptim_kb *decimal* KB
  // (jpegoptim_kb * 1000 bytes). Reproduced here as a plain byte ceiling.
  // Canvas-encoded JPEGs carry no metadata to strip, so only the cap matters.
  //
  // (The wasm engine has no equivalent second pass: its own bisection
  // already targets the exact byte budget requested — targetKb*1024 —
  // directly, with no decimal-KB conversion step. The two engines can
  // therefore land a handful of bytes apart from each other at the same
  // targetKb; both still satisfy "final size ≤ target".)
  const capBytes = (Math.floor((targetKb * 1024) / 1000) - 2) * 1000;

  let finalBytes = bestBytes;
  let q = best;
  while (finalBytes.byteLength > Math.max(0, capBytes) && q < QSCALE_MAX) {
    q += 1;
    finalBytes = await encodeAt(targetW, q);
    log(`info: size-cap tighten q=${q} -> ${Math.round(finalBytes.byteLength / 1024)}kb`);
  }

  const finalHeight = Math.max(1, Math.round((targetW / origW) * origH));
  log(`info: final size ${Math.round(finalBytes.byteLength / 1024)}kb at quality ${q}`);

  return finalize(finalBytes, {
    engine: 'canvas',
    width: targetW,
    height: finalHeight,
    metTarget: true,
  });
}
