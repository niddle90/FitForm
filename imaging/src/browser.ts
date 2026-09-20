/**
 * Browser entry point. Import as 'imaging/browser'.
 *
 * Kept separate from the package root so a Node consumer's bundler never
 * has a reason to evaluate browser-only globals (fetch-relative-to-page,
 * OffscreenCanvas) -- see './node.js' for the Node-side equivalent.
 */
export { createBrowserCodecs } from './browser-codecs.js';
export type { BrowserCodecAssets } from './browser-codecs.js';
export { browserCanvasProvider } from './compress.js';

export { createJpegOptEngineBrowser } from './browser-jpegopt.js';
export type { JpegOptBrowserOptions } from './browser-jpegopt.js';
