# FitForm

FitForm is the client-side photo/PDF toolkit below, plus a
**Vault** tab: a private personal document store backed by the user's own
Google Drive, added without any server or backend of any kind.

## Vault: how it stays private and fully static

- **Scope**: the Vault only ever requests the `drive.file` OAuth scope,
  which is Google's narrowest Drive scope. It grants access to exactly two
  things: files this app creates itself, and files a user explicitly opens
  with Google's picker. This app never asks for (or gets) visibility into
  the rest of a user's Drive. That's enforced by Google server-side, not by
  anything in this codebase.
- **All files live in one folder** ("FitForm Vault"), created automatically
  on first connect.
- **No backend, no client secret**: sign-in uses Google Identity Services'
  browser-only token client (`src/drive/auth.ts`), which is the standard
  OAuth flow for public single-page apps. There's no server to host, and no
  secret to protect. The OAuth Client ID is a public identifier, so it's
  safe to ship in client-side code or a public repo.
- **Nothing persisted except a folder ID**: the access token lives in memory
  for the tab's lifetime only, not in localStorage or sessionStorage.
  Reloading the page requires signing in again. The one thing that *is*
  cached in `localStorage` is the Vault folder's Drive file ID, purely so
  repeat visits reuse the same folder instead of creating a new one each
  time. It's not a credential.
- **Every Drive call is a plain `fetch`** against the REST v3 API
  (`src/drive/api.ts`). There's no Google API client library involved,
  nothing to audit beyond what's in this repo.

### Client ID

Vault always signs in with the Google OAuth Client ID hardcoded as
`DRIVE_CLIENT_ID` in `src/drive/auth.ts`. It is pre-authorized for this
site's origin, and there is no runtime override: no Settings panel, no
field to paste a different ID into. A Client ID saved by an earlier build
under `fitform:drive-client-id` in `localStorage` is deleted on load and
never read.

Running your own copy of FitForm on a different domain (say, your own
GitHub Pages URL)? A Client ID is locked to the origins it's authorized
for, so you'll need your own:

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   and create (or reuse) a project. Then go to **Credentials**, click
   **Create Credentials**, choose **OAuth client ID**, and pick
   **Web application** as the application type.
2. Under **Authorized JavaScript origins**, add your origin, for example
   `https://your-username.github.io` (no path or trailing slash). You
   don't need a redirect URI or an API key.
3. Fill in the OAuth consent screen basics (app name, logo, your email).
   `drive.file` doesn't require Google verification for personal or
   small-scale use, but Google shows an "unverified app" screen until
   you do.
4. Replace the value of `DRIVE_CLIENT_ID` in `src/drive/auth.ts` with
   your Client ID and rebuild.

The Client ID is a public identifier, not a secret, so it's safe to keep
in client-side code or a public repo.

## Branding

The wordmark ("FitForm") is set in **Boogaloo** everywhere it appears: the
app's sidebar and mobile header (`font-brand`, defined as `--font-brand` in
`src/styles.css`) and the static Terms and Privacy pages. Boogaloo has a
single 400 weight, so don't combine it with `font-semibold` or `font-bold`.

All fonts are self-hosted (the app via `@fontsource` packages, the static
pages via `public/fonts/`) rather than loaded from Google Fonts, so no
request to a third party is made unless someone chooses to use Vault.

---

See `CHANGELOG.md` for the full work log, including the code-review
triage (sections 5 through 14) covering correctness, memory, lifecycle,
test coverage, and input-validation fixes.

A browser control surface for the **imaging** image/PDF engine. This is a
separate app: imaging is consumed as an ordinary dependency, vendored at
top-level under `imaging/` and installed the same way a real npm package
would be, rather than copy-pasted into the app's own source. Every call
into imaging happens inside a single Web Worker (`src/engine/worker.ts`);
the UI never touches it directly.

Upload a JPG/PNG/WebP/BMP/TGA image, or a PDF (you can pick a single page
to extract; the underlying engine can render every page, but the UI only
exposes one page at a time), then chain any combination of:

- **Resize**: exact target dimensions, with 8 resampling kernels
  (triangle, Catmull-Rom, Mitchell, Lanczos3, hqx, and all three Magic
  Kernel variants)
- **Crop**: fill a target width/height with a center/top/bottom/left/right
  anchor (a cover-crop, done directly on decoded pixels). It re-encodes in
  whatever format the input already was, since cropping never forces a
  format change, regardless of whether Compress is also enabled (see
  CHANGELOG §9). That's not the same as lossless, though: PNG/BMP/TGA
  re-encode losslessly, but JPEG and WebP crops are still a same-format
  re-encode at a fixed quality (q95), an extra, incidental bit of lossy
  compression on top of whatever the source already had (see CHANGELOG
  §13)
- **Compress**: imaging's bisection search for a target file size, with
  the WASM (libjpeg-turbo/jpegopt) or zero-WASM Canvas engine, a quality
  floor, max scale-down attempts, chroma subsampling, progressive
  encoding, and forced cover-crop dimensions
- **Convert**: re-encode to JPG, PNG, WebP, BMP, or TGA
- **Final output**: leave as-is, lay out on an A4 canvas at 300dpi for
  print (with sizing, margins, alignment, and quality options), or bind
  into a single-page PDF

Every stage streams live log lines and start/done/error status back to
the UI while it runs, and a stage-by-stage table shows the byte size and
dimensions at each step of the pipeline, followed by a download link.

## Getting started

```bash
npm install    # also runs scripts/copy-wasm-assets.mjs (see below)
npm run dev
```

Then open the printed local URL. `npm run build` produces a static
`dist/` you can host anywhere. It's a normal Vite/React app, so nothing
server-side is required; all processing happens client-side in the
worker.

### Running the tests

```bash
npm test
```

This runs all three Node-side suites (no browser needed):

- `npm run pipeline-test` runs unit tests for the app's own pipeline
  logic in `src/state/pipeline.ts` (`buildPipelineConfig`, `isNoopConfig`,
  `needsCrop`, `hidesSizeReduction`, `targetLocksFormat`). It runs
  directly against the TypeScript source via Node 22's built-in
  `--experimental-strip-types`, so no build step is required. This is
  what actually encodes the Simple UI's product semantics, for example
  what "Same as original" plus "Shrink file size" produces for a PNG
  upload, so it's covered independent of the engine itself.
- `npm run client-test` runs regression tests for
  `src/engine/client.ts`'s worker lifecycle (crash detection,
  `restart()`, `cancel()`), against the real, unmodified `EngineClient`
  with a fake `Worker` that implements the same
  `onmessage`/`onerror`/`postMessage`/`terminate` contract a real one
  does. This is also Node 22 type-stripped, with no build step needed.
- `npm run smoke-test` exercises every single imaging call the worker
  makes (every resize method, both compress engines, all five convert
  formats, print layout, PDF bind, and a hand-built PDF through the
  page-count and page-extraction path) against the real pinned WASM
  binaries, using imaging's Node codec variant. Node has no
  `OffscreenCanvas`, so this covers everything except the Canvas
  compress engine, which only runs in an actual browser.

## Architecture

```
imaging/                    vendored imaging package (dependency, not app code)
  src/
    compress.ts              compress to a target file size (canvas or wasm/jpegopt engine)
    printLayout.ts           lay an image out on an A4 canvas at 300dpi
    pdfToImages.ts           extract one or all pages from a PDF as JPEGs
    jpegsToPdf.ts            wrap one or more JPEGs into a single PDF
    convert/                 convert between JPG/PNG/WebP/BMP/TGA
  wasm/                      the jpegopt native WASM engine (jpegopt.wasm + glue)
  native/                    C source for rebuilding jpegopt.wasm (dev-only, see scripts/build-wasm.sh)
  test/                      imaging's own Node-side test suite (npm test inside imaging/)
src/
  engine/
    types.ts                shared request/response/pipeline types
    worker.ts                the *only* file that imports 'imaging'; runs off-thread, running Resize, Crop, Compress, Convert, and Final stages in sequence
    client.ts                main-thread RPC wrapper plus a live log/progress event stream
  components/                one component per pipeline stage / UI concern
  state/pipeline.ts          default pipeline config + formatting helpers
  App.tsx                    wires upload, PDF extraction, pipeline, and result together
scripts/
  copy-wasm-assets.mjs       postinstall: stages the .wasm codec assets as static files
  pipeline-test.mjs          Node-side unit tests for src/state/pipeline.ts, see above
  client-test.mjs            Node-side worker-lifecycle regression tests for src/engine/client.ts, see above
  smoke-test.mjs             Node-side functional check, see above
```

**Why a worker.** imaging's compress bisection can run several encode
passes while searching for a target size, and PDF page rendering can get
expensive at high `maxRenderDim`. Both would otherwise block the main
thread and freeze the UI. Everything, including one-time codec/engine
initialization, happens in `src/engine/worker.ts`; the main thread only
ever sees the plain, transferable message shapes defined in
`src/engine/types.ts`.

**Why a vendored dependency instead of a monorepo or npm-published
package.** imaging isn't published anywhere, so `imaging/` is checked in
at the repo root and referenced as `"imaging": "file:./imaging"` in
`package.json`. `npm install` symlinks it into `node_modules/imaging`
exactly like a real published dependency: the app imports
`from 'imaging'` and `from 'imaging/browser'`, never a relative path into
`imaging/src`. It's a real installable package, with its own
`package.json`, lockfile, and build step (`npm install && npm run build`
inside `imaging/` regenerates its committed `dist/`), just not published
to a registry.

**WASM asset hosting.** imaging's browser codecs need seven pinned
`@jsquash/*`/`@embedpdf/pdfium` `.wasm` files hosted as plain static
files, never bundled or inlined, so they can be `fetch()`-ed at a known
URL. `scripts/copy-wasm-assets.mjs` copies them from `node_modules` into
`public/wasm/` on every `npm install`, nine files in total, since it also
copies two more (hqx and magic-kernel resize kernels) that aren't part of
imaging's own documented asset list. Those two are primed directly
against `@jsquash/resize`'s own `initHqx`/`initMagicKernel` exports in
`worker.ts` so every resize method in the UI actually works, not just
`lanczos3`.

## Deploying to GitHub Pages

A plain `npm run build` produces assets rooted at `/`, which is correct
for a custom domain or a `user.github.io` user page but wrong for a
project page served from `https://user.github.io/repo-name/`. The build
needs to know that subpath ahead of time, so set it via an env var:

```bash
VITE_BASE_PATH=/repo-name/ npm run build
```

There's nothing in `package.json` (no `repository`/`homepage` field)
this could be inferred from automatically, so it isn't. Leaving
`VITE_BASE_PATH` unset keeps the plain root-relative build working
exactly as before.

## Known limitations

- **Duplicate WASM in the production bundle.** Vite's static analysis
  bundles a second copy of most of these `.wasm` files as build assets,
  because the underlying `@jsquash/*`/`pdfium` packages reference their
  wasm via a `new URL('...wasm', import.meta.url)` pattern that gets
  asset-bundled regardless of whether that code path actually runs.
  Since `createBrowserCodecs`/the worker always supply an explicit
  `wasmBinary` fetched from `public/wasm/`, those bundled duplicates
  (dominated by a second ~4.6MB copy of `pdfium.wasm`) are never actually
  fetched at runtime, but they do inflate `dist/` size. Fixing this would
  mean patching upstream packages, which is out of scope here.
- **TGA output isn't natively viewable** in most browsers or OS image
  viewers without a dedicated app. It's included because imaging supports
  it, not because it's a common target format.
- **What Resize re-encodes to depends on what runs after it.** If
  Compress is enabled next, the intermediate is JPEG, since Compress only
  ever produces JPEG anyway, so a lossless PNG in between would just be
  wasted memory (see CHANGELOG §8). If Convert is enabled, the
  intermediate is a lossless PNG, since Convert is about to re-encode to
  whichever final format was picked anyway. If neither runs, meaning
  "Same as original" is selected, Resize re-encodes straight back into
  the *original* source format instead of defaulting to PNG, so "Same as
  original" plus Resize actually keeps the original format (see
  CHANGELOG §12; for a JPEG source this does mean accepting a JPEG
  re-encode, the same trade-off Crop already makes, see CHANGELOG §9).
  Final output as a PDF bind is the one exception: it wants JPEG
  regardless and auto-converts non-JPEG input itself, so a PNG
  intermediate there is a fine, loss-avoiding default.
- The **print** and **bind** steps require JPEG input; the pipeline
  auto-converts non-JPEG input first, and logs it as it happens, rather
  than failing.
