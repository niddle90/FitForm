import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Every `.wasm` codec this app uses is loaded explicitly, with an already-
 * fetched `ArrayBuffer` passed straight in — see imaging's
 * `browser-codecs.ts` (`jpegDecodeMod.init({ wasmBinary: jpegDecWasm })`,
 * `pngEncodeMod.init(pngWasm)`, etc.) and `worker.ts`'s own hqx/magic-kernel
 * priming (`initHqx(hqxBuf)`). `scripts/copy-wasm-assets.mjs` is what puts
 * those bytes somewhere fetchable in the first place, copying them into
 * `public/wasm/` so the app can `fetch()` them by a known URL at runtime.
 *
 * None of that goes through a bundler-visible import. But every one of the
 * underlying wasm-bindgen/wasm-pack-generated glue files this pulls in
 * (`@jsquash/{jpeg,png,webp,resize}`'s codec/pkg/*.js, and
 * `@embedpdf/pdfium`'s browser entry) *also* contains its own unconditional,
 * literal `new URL('foo_bg.wasm', import.meta.url)` — the fallback default
 * those libraries use if a caller *doesn't* supply a binary. We always do,
 * so that line of their code never actually executes. But Rollup's asset
 * plugin doesn't know that: it statically resolves any string literal
 * `new URL(...)` it sees against `import.meta.url`, regardless of whether
 * the surrounding code path is ever reached at runtime, and unconditionally
 * emits the referenced file as a build asset. The result (confirmed with a
 * real `vite build` here): every one of those nine files gets bundled
 * *twice* — once by `copy-wasm-assets.mjs` into `dist/wasm/` (the copy this
 * app's `fetch()` calls actually use) and once more, independently, by
 * Rollup into `dist/assets/*-[hash].wasm` (dead weight nothing ever
 * requests) — roughly doubling this app's production WASM payload for
 * literally nothing. The same applies to `@jsquash/webp`'s SIMD encoder
 * variant (`webp_enc_simd.wasm`) for an unrelated reason: `browser-codecs.ts`
 * always selects the baseline (non-SIMD) encoder on purpose (see its own
 * "NOTE on WebP SIMD"), so that build is never requested by *either* path
 * and is pure dead weight regardless of this duplication issue.
 *
 * This can't be fixed inside those packages (they're pinned, versioned
 * dependencies — see browser-codecs.ts's own header comment on why exact
 * versions matter here) or by preventing Rollup from finding the reference
 * in the first place (the `new URL(...)` literal is deep inside each
 * package's own compiled glue code, not something this app's source
 * controls). Instead, this strips the confirmed-dead duplicates back out of
 * the finished bundle: by the time `generateBundle` runs, every asset this
 * app's own runtime code actually needs (the copies under `wasm/`) has
 * already been decided independently by `copy-wasm-assets.mjs`, so deleting
 * a same-named `assets/*-[hash].wasm` file here can't remove anything this
 * app would otherwise have fetched.
 */
function stripDeadWasmBindgenDefaults(): Plugin {
  const deadWasmBaseNames = [
    'mozjpeg_dec',
    'mozjpeg_enc',
    'squoosh_png_bg',
    'webp_dec',
    'webp_enc',
    'webp_enc_simd', // never selected at all, see the comment above
    'squoosh_resize_bg',
    'squooshhqx_bg',
    'jsquash_magic_kernel_bg',
    'pdfium',
  ];
  const deadWasmPattern = new RegExp(`^assets/(${deadWasmBaseNames.join('|')})-[\\w-]+\\.wasm$`);
  return {
    name: 'fitform:strip-dead-wasm-bindgen-defaults',
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (deadWasmPattern.test(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Vite's default base is '/', correct for a domain-root deployment but
  // wrong for a GitHub Pages *project* page (https://user.github.io/repo/),
  // which needs every asset path prefixed with /repo/. There's no repo
  // name to discover automatically here (no `repository`/`homepage` field
  // in package.json, and the name a repo is cloned under isn't guaranteed
  // to match package.json's "name" anyway), so this reads it from an env
  // var instead of guessing: build with
  //   VITE_BASE_PATH=/repo-name/ npm run build
  // for a project page, or leave it unset for root/user-page deployment
  // (`npm run build` alone still does the right, unprefixed thing). This
  // only fixes *this* value; import.meta.env.BASE_URL downstream (see
  // worker.ts's ensureReady) already picks up whatever base ends up set
  // here, so nothing else needs to change for a subpath deploy.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // The engine worker (src/engine/worker.ts) uses top-level `import`
  // statements to pull in imaging and its jSquash/pdfium peers, so it
  // needs to be built/served as a real ES module worker, not Vite's
  // default classic/IIFE worker output.
  worker: {
    format: 'es',
    plugins: () => [stripDeadWasmBindgenDefaults()],
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    // These packages self-initialize their own WASM (see
    // scripts/copy-wasm-assets.mjs's comment on hqx/magic-kernel) using
    // `new URL(..., import.meta.url)` patterns esbuild's dependency
    // pre-bundler doesn't rewrite the same way Vite's production build
    // does. Excluding them from pre-bundling keeps dev and build behavior
    // consistent for those asset lookups.
    exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/resize', '@embedpdf/pdfium'],
    // imaging is only ever imported from inside the Worker
    // (src/engine/worker.ts), so Vite's dependency-discovery crawl (which
    // starts at index.html/main.tsx) never finds it and never pre-bundles
    // it in dev — it gets served as a raw, untransformed file instead.
    // That's normally harmless, but imaging's jpegopt-engine.js does
    // `import createJpegOptModule from '../wasm/jpegopt.js'`, and
    // wasm/jpegopt.js is a CommonJS/UMD Emscripten glue file (see its own
    // wasm/package.json: { "type": "commonjs" }) with no ES `export`
    // statement. Served unbundled to a real browser ESM loader, that
    // import has no default export to bind to, and the worker's module
    // graph fails to link — the worker dies before any of our code runs,
    // which is why the UI just reports a bare "engine worker crashed"
    // with no further detail. `vite build` doesn't hit this because
    // Rollup bundles the worker and CJS-interops jpegopt.js properly;
    // explicitly including imaging here makes esbuild do the same
    // CJS->ESM interop in dev, so behavior matches production.
    include: ['imaging', 'imaging/browser'],
  },
});
