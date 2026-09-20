// Copies nine .wasm binaries out of node_modules and into public/wasm,
// where Vite serves them as plain static files with the correct
// `Content-Type: application/wasm` — required per vault-suite's README
// ("WASM asset hosting" section): these files must never be
// inlined/bundled by the bundler. Seven of the nine are the jSquash/
// pdfium binaries vault-suite's browser codecs need at runtime; the
// other two (hqx, magic-kernel) are extra resize kernels this app
// primes itself — see the comment further down.
//
// jpegopt.wasm (vxpress's native engine) is NOT copied here — it ships
// inside vault-suite itself and is resolved automatically by
// createJpegOptEngineBrowser() via `new URL(..., import.meta.url)`,
// which Vite auto-detects and copies on its own. Nothing to do for it.
//
// Two extra files (hqx, magic-kernel) are also copied here even though
// vault-suite's own README doesn't list them: vault-suite's ResizeCodec
// type permits every @jsquash/resize method ('hqx', 'magicKernel*'
// included), but its browser-codecs.ts only ever primes the plain
// 'resize' wasm module before handing back a ResizeCodec — the other two
// methods' wasm is lazily self-initialized by @jsquash/resize the first
// time one of those methods is used, via its own default same-directory
// `import.meta.url` fetch. This app wants every documented resize method
// selectable from the UI, so the worker (see engine/worker.ts) primes
// those two modules itself too, directly against @jsquash/resize's own
// initHqx/initMagicKernel exports, using these copies.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'public', 'wasm');

const files = [
  ['node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm', 'mozjpeg_dec.wasm'],
  ['node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', 'mozjpeg_enc.wasm'],
  ['node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm', 'squoosh_png_bg.wasm'],
  ['node_modules/@jsquash/webp/codec/dec/webp_dec.wasm', 'webp_dec.wasm'],
  ['node_modules/@jsquash/webp/codec/enc/webp_enc.wasm', 'webp_enc.wasm'],
  ['node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm', 'squoosh_resize_bg.wasm'],
  ['node_modules/@embedpdf/pdfium/dist/pdfium.wasm', 'pdfium.wasm'],
  ['node_modules/@jsquash/resize/lib/hqx/pkg/squooshhqx_bg.wasm', 'squooshhqx_bg.wasm'],
  ['node_modules/@jsquash/resize/lib/magic-kernel/pkg/jsquash_magic_kernel_bg.wasm', 'jsquash_magic_kernel_bg.wasm'],
];

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const [src, name] of files) {
  const srcPath = join(root, src);
  if (!existsSync(srcPath)) {
    console.warn(`[copy-wasm-assets] missing ${src} — run "npm install" first`);
    continue;
  }
  copyFileSync(srcPath, join(outDir, name));
  copied++;
}

console.log(`[copy-wasm-assets] copied ${copied}/${files.length} codec assets to public/wasm/`);
