/**
 * Shared types between the UI (main thread) and the engine worker.
 *
 * Every imaging call happens inside worker.ts — nothing in src/
 * outside engine/ ever imports 'imaging' directly. The UI only ever
 * sees these plain, structured-cloneable/transferable message shapes.
 */

import type {
  CompressEngine,
  SubsamplingMode,
  CropAnchor,
} from 'imaging';

export type { CompressEngine, SubsamplingMode, CropAnchor };

export type ImageFormat = 'jpg' | 'png' | 'bmp' | 'tga' | 'webp';

export type ResizeMethod =
  | 'triangle'
  | 'catrom'
  | 'mitchell'
  | 'lanczos3'
  | 'hqx'
  | 'magicKernel'
  | 'magicKernelSharp2013'
  | 'magicKernelSharp2021';

/**
 * Continuous position within the "cover crop" slack, as a fraction on
 * each axis: 0 = fully at the top/left of the available travel range,
 * 1 = fully at the bottom/right, 0.5 = centered (whatever `anchor`'s
 * named presets used to give you, minus the ones in between). Whichever
 * axis has no slack (the image's shorter side after scale-to-cover) is
 * simply ignored on that axis — see coverCropOrigin in worker.ts.
 */
export interface CropOffset {
  x: number;
  y: number;
}

export interface ResizeStepConfig {
  enabled: boolean;
  width?: number;
  height?: number;
  lockAspect: boolean;
  method: ResizeMethod;
}

export type CropMode = 'cover' | 'zoom' | 'free';

/** A crop selection as fractions (0..1) of the *source* image's own width/height. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropStepConfig {
  enabled: boolean;
  width?: number;
  height?: number;
  anchor: CropAnchor;
  /**
   * Freely-dragged position from the CropPositioner UI (mode 'cover').
   * Takes priority over `anchor` when present; `anchor` remains the
   * fallback for callers that never set a continuous position.
   */
  offset?: CropOffset;
  /**
   * An explicit selection from the CropSelector UI, used by modes 'zoom'
   * and 'free'. 'zoom' cuts this rectangle out of the source and then
   * resizes it (a stretch, if its aspect doesn't land exactly on
   * width/height) to hit width x height; 'free' cuts it out as-is —
   * width/height are ignored and the stage's output size is simply the
   * selection's own pixel dimensions.
   */
  rect?: CropRect;
  /**
   * 'cover' (default): scale up just enough to cover width x height, then
   * cut the excess — the minimum crop that reaches an exact size, never
   * stretches. 'zoom': an arbitrary aspect-locked `rect`, then resize
   * that selection to width x height — lets the user crop away more (or
   * less) than the 'cover' minimum, at the cost of a resize. 'free': an
   * arbitrary unlocked `rect`, no target size at all — output is exactly
   * whatever the user selected.
   */
  mode: CropMode;
  method: ResizeMethod;
}

export interface CompressStepConfig {
  enabled: boolean;
  engine: CompressEngine;
  targetKb: number;
  // wasm-engine-only controls
  useDimensions: boolean;
  width?: number;
  height?: number;
  fixedDimension: boolean;
  cropAnchor: CropAnchor;
  minQuality: number;
  maxScaleTries: number;
  subsampling: SubsamplingMode;
  progressive: boolean;
  allowMiss: boolean;
}

export interface ConvertStepConfig {
  enabled: boolean;
  format: ImageFormat;
  quality: number;
}

export type FinalStepConfig =
  | { kind: 'none' }
  | {
      kind: 'print';
      sizeMode: 'auto' | 'width' | 'height';
      widthCm?: number;
      heightCm?: number;
      topCm: number;
      hAlign: 'left' | 'right' | 'center';
      leftCm: number;
      rightCm: number;
      quality: number;
    }
  | { kind: 'bind' };

export interface PipelineConfig {
  resize: ResizeStepConfig;
  crop: CropStepConfig;
  compress: CompressStepConfig;
  convert: ConvertStepConfig;
  final: FinalStepConfig;
}

export interface StageResultMeta {
  stage: 'source' | 'resize' | 'crop' | 'compress' | 'convert' | 'print' | 'bind';
  label: string;
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
  extra?: Record<string, string | number | boolean>;
}

export interface RunResult {
  data: Uint8Array;
  mime: string;
  filename: string;
  stages: StageResultMeta[];
}

export interface JpegMetaInfo {
  w: number;
  h: number;
  orient: number;
  cs: 'DeviceGray' | 'DeviceCMYK' | 'DeviceRGB';
}

// ── Worker request/response envelope ──────────────────────────────────

export type WorkerRequest =
  | { id: number; type: 'init' }
  | { id: number; type: 'inspect'; bytes: Uint8Array }
  | { id: number; type: 'pdf-info'; bytes: Uint8Array }
  | {
      id: number;
      type: 'pdf-extract';
      bytes: Uint8Array;
      page: number | null; // null => every page
      quality: number;
      maxRenderDim: number;
    }
  | { id: number; type: 'run'; bytes: Uint8Array; filenameHint: string; config: PipelineConfig };

export interface PdfExtractedPage {
  pageNumber: number;
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface InspectInfo {
  format: ImageFormat | null;
  width?: number;
  height?: number;
  jpegMeta?: JpegMetaInfo | null;
}

export type WorkerResponsePayload =
  | { kind: 'ready' }
  | { kind: 'inspect'; info: InspectInfo }
  | { kind: 'pdf-info'; pageCount: number }
  | { kind: 'pdf-extract'; pages: PdfExtractedPage[] }
  | { kind: 'run'; result: RunResult };

export type WorkerMessage =
  | { id: number; type: 'log'; stage: string; message: string }
  | { id: number; type: 'progress'; stage: string; status: 'start' | 'done' | 'error' }
  | { id: number; type: 'result'; payload: WorkerResponsePayload }
  | { id: number; type: 'error'; tool?: string; code?: string; message: string };
