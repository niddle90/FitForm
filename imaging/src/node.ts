/**
 * Node.js entry point. Import as 'imaging/node'.
 *
 * Kept separate from the package root so a browser bundler never tries to
 * resolve `node:fs` -- see './browser.js' for the browser-side equivalent.
 */
export { createNodeCodecs } from './node-codecs.js';
export { nodeCanvasProvider } from './node-canvas-provider.js';

export { createJpegOptEngineNode } from './node-jpegopt.js';
export type { JpegOptNodeOptions } from './node-jpegopt.js';
