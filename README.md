# FitForm

FitForm is the client-side photo/PDF toolkit below, plus a
**Vault** tab: a private personal document store backed by the user's own
Google Drive, added without any server or backend of any kind.

## Vault: how it stays private and fully static

- **Scope**: the Vault only ever requests the `drive.file` OAuth scope —
  Google's narrowest Drive scope. It grants access to exactly two things:
  files this app creates itself, and files a user explicitly opens with
  Google's picker. This app never asks for (or gets) visibility into the
  rest of a user's Drive. That's enforced by Google server-side, not by
  anything in this codebase.
- **All files live in one folder** ("FitForm Vault"), created automatically
  on first connect.
- **No backend, no client secret**: sign-in uses Google Identity Services'
  browser-only token client (`src/drive/auth.ts`), which is the standard
  OAuth flow for public single-page apps. There's no server to host, and no
  secret to protect — the OAuth Client ID is a public identifier, safe to
  ship in client-side code / a public repo.
- **Nothing persisted except a folder ID**: the access token lives in memory
  for the tab's lifetime only (not localStorage/sessionStorage). Reloading
  the page requires signing in again. The one thing that *is* cached in
  `localStorage` is the Vault folder's Drive file ID, purely so repeat
  visits reuse the same folder instead of creating a new one each time —
  it's not a credential.
- **Every Drive call is a plain `fetch`** against the REST v3 API
  (`src/drive/api.ts`) — no Google API client library, nothing to audit
  beyond what's in this repo.

### One-time setup (per deployment)

Because this is a static site with no server, each person who deploys their
own copy needs their own OAuth Client ID registered against their own
domain — a shared, hardcoded Client ID couldn't be locked to everyone's
GitHub Pages URL at once.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create (or reuse) a project, then **Credentials → Create Credentials →
   OAuth client ID → Application type: Web application**.
2. Under **Authorized JavaScript origins**, add your GitHub Pages origin,
   e.g. `https://your-username.github.io` (no path/trailing slash).
3. You do *not* need a redirect URI (the token client flow doesn't use
   one) or an API key. You also don't need to separately enable the Drive
   API's OAuth consent scopes beyond the default — `drive.file` doesn't
   require Google verification/review for personal or small-scale use the
   way broader scopes do, though Google may still show an "unverified app"
   screen until you complete OAuth consent screen basics (app name, logo,
   your email) in the same Console.
4. Open the deployed site → **Vault** tab → **Settings** (gear icon) →
   paste the Client ID → **Save**. It's stored in that browser's
   `localStorage` only.
5. Click **Continue with Google**.

That's it — no environment variables, no build-time secrets. The Client ID
is entered at runtime by whoever uses the deployment, so the same built
`dist/` bundle works for any origin its Client ID has been authorized for.

---

See `CHANGELOG.md` for the full work log, including the code-review
triage (§5–§14) covering correctness, memory, lifecycle, test coverage,
and input-validation fixes.

A browser control surface for the **imaging** image/PDF engine. This is a
separate app — imaging is consumed as an ordinary dependency
(vendored at top-level under `imaging/`, installed the same way a real
npm package would be), not copy-pasted into the app's own source. Every
call into imaging happens inside a single Web Worker
(`src/engine/worker.ts`); the UI never touches it directly.

Upload a JPG/PNG/WebP/BMP/TGA image, or a PDF (pick a single page to
extract — the underlying engine can render every page, but the UI only
exposes one page at a time), then chain any combination of:

- **Resize** — exact target dimensions, 8 resampling kernels (triangle,
  Catmull-Rom, Mitchell, Lanczos3, hqx, and all three Magic Kernel
  variants)
- **Crop** — fill a target width/height with a center/top/bottom/left/
  right anchor (cover-crop, done directly on decoded pixels). Re-encodes
  in whatever format the input already was — cropping never forces a
  format change, independent of whether Compress is also enabled (see
  CHANGELOG §9). That's not the same as lossless, though: PNG/BMP/TGA
  re-encode losslessly, but JPEG and WebP crops are still a same-format
  re-encode at a fixed quality (q95) — an extra, incidental generation
  of lossy compression on top of whatever the source already had (see
  CHANGELOG §13)
- **Compress** — imaging's bisection search for a target file size,
  with the WASM (libjpeg-turbo/jpegopt) or zero-WASM Canvas engine,

  quality floor, max scale-down attempts, chroma subsampling,
  progressive encoding, and forced cover-crop dimensions
- **Convert** — re-encode to JPG / PNG / WebP / BMP / TGA
- **Final output** — leave as-is, lay out on an A4 canvas at 300dpi for
  print (sizing, margins, alignment, quality), or bind into a
  single-page PDF

Every stage streams live log lines and start/done/error status back to
the UI while it runs, and a stage-by-stage table shows the byte size and
dimensions at each step of the pipeline, followed by a download link.

## Getting started

```bash
npm install    # also runs scripts/copy-wasm-assets.mjs (see below)
npm run dev
```

Then open the printed local URL. `npm run build` produces a static
`dist/` you can host anywhere (it's a normal Vite/React app — nothing
server-side is required, all processing happens client-side in the
worker).

### Running the tests

```bash
npm test
```

This runs all three Node-side suites (no browser needed):

- `npm run pipeline-test` — unit tests for the app's own pipeline logic
  in `src/state/pipeline.ts` (`buildPipelineConfig`, `isNoopConfig`,
  `needsCrop`, `hidesSizeReduction`, `targetLocksFormat`). Runs directly
  against the TypeScript source via Node 22's built-in
  `--experimental-strip-types`, no build step required. This is what
  actually encodes the Simple UI's product semantics — e.g. what
  "Same as original" + "Shrink file size" produces for a PNG upload —
  so it's covered independent of the engine itself.
- `npm run client-test` — regression tests for `src/engine/client.ts`'s
  worker lifecycle (crash detection, `restart()`, `cancel()`), run
  against the real, unmodified `EngineClient` with a fake `Worker` that
  implements the same `onmessage`/`onerror`/`postMessage`/`terminate`
  contract a real one does. Also Node 22 type-stripped, no build step.
- `npm run smoke-test` — exercises every single imaging call the
  worker makes (every resize method, both compress engines, all five
  convert formats, print layout, PDF bind, and a hand-built PDF through
  the page-count + page-extraction path) against the real pinned WASM
  binaries, using imaging's Node codec variant (Node has no
  `OffscreenCanvas`, so this covers everything except the Canvas
  compress engine — that one only runs in an actual browser).

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
    worker.ts                *only* file that imports 'imaging' — runs off-thread; runs Resize, Crop, Compress, Convert, and Final stages in sequence
    client.ts                main-thread RPC wrapper + live log/progress event stream
  components/                one component per pipeline stage / UI concern
  state/pipeline.ts          default pipeline config + formatting helpers
  App.tsx                    wires upload -> PDF extraction -> pipeline -> result
scripts/
  copy-wasm-assets.mjs       postinstall: stages the .wasm codec assets as static files
  pipeline-test.mjs          Node-side unit tests for src/state/pipeline.ts, see above
  client-test.mjs            Node-side worker-lifecycle regression tests for src/engine/client.ts, see above
  smoke-test.mjs             Node-side functional check, see above
```

**Why a worker.** imaging's compress bisection can run several
encode passes searching for a target size, and PDF page rendering can be
expensive at high `maxRenderDim` — both would otherwise block the main
thread and freeze the UI. Everything (including one-time codec/engine
initialization) happens in `src/engine/worker.ts`; the main thread only
ever sees the plain, transferable message shapes defined in
`src/engine/types.ts`.

**Why a vendored dependency instead of a monorepo/npm-published
package.** imaging isn't published anywhere, so `imaging/` is checked in
at the repo root and referenced as `"imaging": "file:./imaging"` in
`package.json`. `npm install` symlinks it into `node_modules/imaging`
exactly like a real published dependency — the app imports
`from 'imaging'` / `from 'imaging/browser'`, never a relative path into
`imaging/src`. It's a real installable package (own `package.json`,
lockfile, and build step — `npm install && npm run build` inside
`imaging/` regenerates its committed `dist/`), just not published to a
registry.

**WASM asset hosting.** imaging's browser codecs need seven pinned
`@jsquash/*`/`@embedpdf/pdfium` `.wasm` files hosted as plain static
files (never bundled/inlined) so they can be `fetch()`-ed at a known
URL. `scripts/copy-wasm-assets.mjs` copies them from `node_modules` into
`public/wasm/` on every `npm install` — nine files in total, since it
also copies two more (hqx and magic-kernel resize kernels) that aren't
part of imaging's own documented asset list. Those two are primed
directly against `@jsquash/resize`'s own `initHqx`/`initMagicKernel`
exports in `worker.ts` so every resize method in the UI actually works,
not just `lanczos3`.

## Deploying to GitHub Pages

A plain `npm run build` produces assets rooted at `/`, correct for a
custom domain or a `user.github.io` user page but wrong for a project
page served from `https://user.github.io/repo-name/` — the build needs
to know that subpath ahead of time. Set it via an env var:

```bash
VITE_BASE_PATH=/repo-name/ npm run build
```

There's nothing in `package.json` (no `repository`/`homepage` field)
this could be inferred from automatically, so it isn't — leaving
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
  (dominated by a second ~4.6MB copy of `pdfium.wasm`) are never
  actually fetched at runtime, but they do inflate `dist/` size. Fixing
  this would mean patching upstream packages, which is out of scope
  here.
- **TGA output isn't natively viewable** in most browsers/OS image
  viewers without a dedicated app — it's included because imaging
  supports it, not because it's a common target format.
- **What Resize re-encodes to depends on what runs after it.** If
  Compress is enabled next, the intermediate is JPEG (Compress only ever
  produces JPEG anyway, so a lossless PNG in between would just be
  wasted memory — see CHANGELOG §8). If Convert is enabled, the
  intermediate is a lossless PNG, since Convert is about to re-encode to
  whichever final format was picked anyway. If neither runs — i.e.
  "Same as original" — Resize re-encodes straight back into the
  *original* source format instead of defaulting to PNG, so "Same as
  original" + Resize actually keeps the original format (see CHANGELOG
  §12; for a JPEG source this does mean accepting a JPEG re-encode,
  same trade-off Crop already makes — see CHANGELOG §9). Final output as
  a PDF bind is the one exception: it wants JPEG regardless and
  auto-converts non-JPEG input itself, so a PNG intermediate there is a
  fine, loss-avoiding default.
- The **print** and **bind** steps require JPEG input; the pipeline
  auto-converts non-JPEG input first (logged as it happens) rather than
  failing.
