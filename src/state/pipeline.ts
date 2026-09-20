import type {
  PipelineConfig,
  ImageFormat,
  ResizeMethod,
  CompressEngine,
  SubsamplingMode,
  CropAnchor,
  CropOffset,
  CropRect,
  CropMode,
} from '../engine/types';

// ── formatting helpers ────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

export function pctChange(before: number, after: number): string {
  if (before === 0) return '—';
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Wraps bytes for URL.createObjectURL / new Blob() without copying. The
 * Blob constructor already reads exactly a TypedArray view's own
 * byteOffset/byteLength (it does not serialize the whole underlying
 * buffer), so the `.slice()` this used to do first bought no
 * correctness, only an extra full-size copy — real memory pressure for
 * a large photo held in a Blob purely for a preview.
 */
export function bytesToBlob(bytes: Uint8Array, type?: string): Blob {
  return new Blob([bytes as unknown as BlobPart], type ? { type } : undefined);
}

// ── the end-user-facing model ─────────────────────────────────────────
//
// This is what the UI actually edits. It's deliberately smaller than
// PipelineConfig: several technical stages collapse into one control
// here (see buildPipelineConfig below), and everything a casual user
// doesn't need a decision about gets a sensible default that only
// shows up in the "Advanced" panel.

export type ExportTarget = 'same' | ImageFormat | 'pdf';

export const EXPORT_TARGETS: { value: ExportTarget; label: string }[] = [
  { value: 'same', label: 'Same as original' },
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'bmp', label: 'BMP' },
  { value: 'tga', label: 'TGA' },
  { value: 'pdf', label: 'PDF' },
];

/** Formats with no lossy/target-size compression — PNG, BMP and TGA all re-encode losslessly. */
const LOSSLESS_FORMATS: ReadonlySet<ExportTarget> = new Set(['png', 'bmp', 'tga']);

export interface AdvancedSettings {
  resizeMethod: ResizeMethod;
  compressEngine: CompressEngine;
  minQuality: number;
  maxScaleTries: number;
  subsampling: SubsamplingMode;
  progressive: boolean;
  allowMiss: boolean;
  convertQuality: number;
}

export interface SimpleState {
  width?: number;
  height?: number;
  cropAnchor: CropAnchor;
  /**
   * How the crop box behaves — see CropMode's own doc comment. Only
   * matters once a crop is actually happening (see needsCrop).
   */
  cropMode: CropMode;
  /** Set by CropPositioner once the user drags in 'cover' mode; overrides cropAnchor when present. */
  cropOffset?: CropOffset;
  /** Set by CropSelector in 'zoom'/'free' modes — an explicit, resizable selection. */
  cropRect?: CropRect;
  reduceSize: boolean;
  targetKb: number;
  exportTarget: ExportTarget;
  advanced: AdvancedSettings;
}

export function defaultAdvancedSettings(): AdvancedSettings {
  return {
    resizeMethod: 'lanczos3',
    compressEngine: 'auto',
    minQuality: 25,
    maxScaleTries: 5,
    subsampling: '4:2:0',
    progressive: false,
    allowMiss: false,
    convertQuality: 90,
  };
}

export function defaultSimpleState(): SimpleState {
  return {
    width: undefined,
    height: undefined,
    cropAnchor: 'center',
    cropMode: 'cover',
    reduceSize: true,
    targetKb: 500,
    exportTarget: 'same',
    advanced: defaultAdvancedSettings(),
  };
}

/**
 * True when a crop stage should run at all: either both sides are pinned
 * (the 'cover'/'zoom' cases — a target size that needs reaching), or the
 * user is in free-form 'free' mode and has actually drawn a selection —
 * that mode never needs width/height, the selection *is* the size.
 */
export function needsCrop(s: Pick<SimpleState, 'width' | 'height' | 'cropMode' | 'cropRect'>): boolean {
  if (s.cropMode === 'free') return !!s.cropRect;
  return !!s.width && !!s.height;
}

/** True when export target forces its own internal re-encode, making a separate re-format pass moot. */
export function targetLocksFormat(t: ExportTarget): boolean {
  return t === 'pdf';
}

/**
 * True for formats that can't be shrunk to a target size: PNG, BMP and TGA
 * all re-encode losslessly, so "compress to N KB" can't be honored for
 * them — the result would usually come out *larger* than the original
 * (compressing to a small JPEG internally, then re-inflating it back to a
 * lossless format), which breaks the promise the control makes. JPG and
 * WebP are genuinely lossy, so shrinking stays meaningful there — as does
 * PDF, which just wraps whatever JPEG it's given.
 */
export function hidesSizeReduction(t: ExportTarget): boolean {
  return LOSSLESS_FORMATS.has(t);
}

/** Whether the current simple state would produce a no-op pipeline (nothing to run). */
export function isNoopConfig(s: SimpleState): boolean {
  const crop = needsCrop(s);
  const oneDim = !!s.width !== !!s.height;
  const reducing = s.reduceSize && !hidesSizeReduction(s.exportTarget);
  const converting = !targetLocksFormat(s.exportTarget) && s.exportTarget !== 'same';
  const finalizing = s.exportTarget === 'pdf';
  return !crop && !oneDim && !reducing && !converting && !finalizing;
}

/**
 * Translates the simple end-user state into the full technical
 * PipelineConfig the engine worker understands.
 *
 * Key merges:
 *  - Dimensions: one side filled -> plain proportional Resize stage.
 *    Both sides filled -> a dedicated Crop stage does a pixel-level
 *    cover-crop and re-encodes in whatever format the image already
 *    was — no forced JPEG conversion, no incidental re-compression, for
 *    any source format. (This used to route through the WASM compress
 *    engine's pinned-dimension + anchor crop instead, which worked but
 *    meant "just crop" silently produced JPEG output even for a
 *    PNG/WebP/BMP/TGA source.) Compress, if also enabled via "reduce
 *    file size", simply runs afterward on the already-cropped image —
 *    the two concerns are fully independent now, so Compress never
 *    needs to know about dimensions or a crop anchor.
 *  - Export target: one control drives Convert *and* Final. PDF skips
 *    Convert (jpegsToPdf wants a JPEG regardless of the picked format) but
 *    keeps "reduce file size" available, so a compressed JPEG is what
 *    actually gets wrapped into the PDF. Lossless image formats (PNG,
 *    BMP, TGA) never run the size-reduction pass at all — see
 *    hidesSizeReduction — so choosing one of them can't silently produce
 *    a file bigger than what "shrink file size" promised.
 */
export function buildPipelineConfig(s: SimpleState): PipelineConfig {
  const crop = needsCrop(s);
  const oneDim = !!s.width !== !!s.height;
  const locksFormat = targetLocksFormat(s.exportTarget);
  const reducing = s.reduceSize && !hidesSizeReduction(s.exportTarget);

  const resize: PipelineConfig['resize'] = {
    enabled: oneDim,
    width: s.width,
    height: s.height,
    lockAspect: true,
    method: s.advanced.resizeMethod,
  };

  const cropStep: PipelineConfig['crop'] = {
    enabled: crop,
    width: crop ? s.width : undefined,
    height: crop ? s.height : undefined,
    anchor: s.cropAnchor,
    offset: crop && s.cropMode === 'cover' ? s.cropOffset : undefined,
    rect: crop && s.cropMode !== 'cover' ? s.cropRect : undefined,
    mode: s.cropMode,
    method: s.advanced.resizeMethod,
  };

  const compress: PipelineConfig['compress'] = {
    enabled: reducing,
    engine: s.advanced.compressEngine,
    targetKb: s.targetKb,
    useDimensions: false,
    width: undefined,
    height: undefined,
    fixedDimension: false,
    cropAnchor: s.cropAnchor,
    minQuality: s.advanced.minQuality,
    maxScaleTries: s.advanced.maxScaleTries,
    subsampling: s.advanced.subsampling,
    progressive: s.advanced.progressive,
    allowMiss: s.advanced.allowMiss,
  };

  const isImageFormat = !locksFormat && s.exportTarget !== 'same';
  // Compress (compress) always hands back JPEG bytes, regardless of what
  // engine/target it used internally — that's the whole point of the
  // jpegopt bisection, hitting `targetKb` by tuning quality, not by
  // picking a format. If the user's chosen export target is *also* 'jpg',
  // running Convert afterward doesn't change format at all; it just
  // re-encodes those already-size-tuned bytes a second time through
  // convertFormat, which decodes and re-encodes at a fixed `convertQuality` (via
  // jsquash's JPEG encoder, not jpegopt) with no idea a target size was
  // ever in play. That silently discards Compress's result: a 41 KB
  // jpegopt-tuned JPEG can come out the other side of this redundant pass
  // at 140 KB, because convertFormat's fixed quality has nothing to do with
  // `targetKb` and jsquash's encoder doesn't produce the same bytes at the
  // same quality as jpegopt's. Skip Convert whenever it would be a no-op
  // format-wise on top of a size reduction that just ran.
  const convertRedundantAfterCompress = reducing && s.exportTarget === 'jpg';
  const convert: PipelineConfig['convert'] = {
    enabled: isImageFormat && !convertRedundantAfterCompress,
    format: isImageFormat ? (s.exportTarget as ImageFormat) : 'jpg',
    quality: s.advanced.convertQuality,
  };

  const final: PipelineConfig['final'] = s.exportTarget === 'pdf' ? { kind: 'bind' } : { kind: 'none' };

  return { resize, crop: cropStep, compress, convert, final };
}
