export { compress } from './compress.js';
export type {
  CompressOptions,
  CompressEngine,
  CompressResultInfo,
  CanvasProvider,
  DecodedBitmap,
} from './compress.js';

export { createJpegOptEngineFromBinary } from './jpegopt-engine.js';
export type {
  JpegOptEngine,
  JpegOptRunOptions,
  JpegOptResult,
  SubsamplingMode,
  CropAnchor,
} from './jpegopt-engine.js';

export { printLayout } from './printLayout.js';
export type { PrintLayoutOptions, PrintLayoutCodecs } from './printLayout.js';

export { convertFormat, detectFormat, formatFromString, formatFromPath } from './convert/index.js';
export type { ConvertOptions, ConvertCodecs, ImageFormat } from './convert/index.js';
// Exposed alongside convertFormat so a caller that already holds decoded pixels
// (e.g. after a crop or other in-memory transform) can encode straight to
// BMP/TGA without a redundant decode->convert round trip through bytes.
export { encodeBmp, decodeBmp } from './convert/bmp.js';
export { encodeTga, decodeTga } from './convert/tga.js';

export { jpegsToPdf, parseJpegMeta } from './jpegsToPdf.js';
export type { JpegsToPdfResult, JpegMeta } from './jpegsToPdf.js';

export { pdfToImages } from './pdfToImages.js';
export type { PdfToImagesOptions, PdfToImagesCodecs, PdfToImagesPage } from './pdfToImages.js';

export type {
  VaultCodecs,
  JpegCodec,
  PngCodec,
  WebpCodec,
  ResizeCodec,
  PdfiumBinding,
  ResizeMethod,
} from './codecs.js';

export { VaultError, type VaultErrorCode } from './errors.js';
export { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, assertSaneImageDimensions } from './limits.js';
export { assertDecodableImageSize } from './decode-guard.js';
