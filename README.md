<p align="center">
  <img src="public/logo.svg" alt="FitForm" width="88">
</p>

<h1 align="center">FitForm</h1>

<p align="center">
  A client-side image and PDF workspace for resizing, cropping, compression,
  format conversion, and document storage, all in the browser.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/build-Vite-646CFF?logo=vite&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/lang-TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Backend" src="https://img.shields.io/badge/backend-none-lightgrey">
</p>

<p align="center">
  <a href="https://fitform.slek.dev/"><strong>Open FitForm</strong></a>
  &nbsp;|&nbsp;
  <a href="https://fitform.slek.dev/privacy.html">Privacy</a>
  &nbsp;|&nbsp;
  <a href="https://fitform.slek.dev/terms.html">Terms</a>
</p>

---

## Overview

FitForm is a browser-based image and PDF toolkit built around one idea: give
people precise control over their files without making them upload those
files to a processing server.

It pairs a clean visual workflow with a processing engine that handles image
resizing, cover cropping, target-size compression, format conversion, PDF
page extraction, and JPEG-to-PDF creation, entirely client-side. Expensive
work runs in a Web Worker, so the interface stays responsive even on large
files.

An optional **Vault** lets you save documents to your own Google Drive, so
FitForm never needs a hosted database or file storage of its own.

## How it works

A file enters the pipeline, its metadata gets inspected, the selected
operations are assembled in order, and the engine runs them one after
another. The result comes back to the interface with its final dimensions,
format, and file size.

The interface and the processing engine are kept deliberately separate. The
React app owns pipeline controls, file selection, and result presentation.
The [`imaging`](./imaging) package owns the actual image and PDF operations.
They only communicate through a single Web Worker. That boundary matters
because a target-size JPEG search can take several encoding passes, and PDF
rendering can be memory-hungry, so neither should block the main thread. If
the worker crashes, the app detects it and offers a restart rather than
silently failing every call afterward, and a run in progress can be
cancelled from the UI.

The processing flow looks like this:

1. Browser UI collects the pipeline configuration.
2. The engine client sends it to a Web Worker.
3. The imaging engine runs the requested steps: resize, crop, compress,
   convert, PDF render or create.
4. The result is returned to the UI as a preview, along with its metadata
   and a download link.

## Features

| Feature | What it does |
|---|---|
| **Resize** | Scales to an exact width and height using Triangle, Catmull-Rom, Mitchell, Lanczos3, HQX, or Magic Kernel resampling. |
| **Crop** | Cover-style crop against the decoded pixels, anchored to center, top, bottom, left, or right. Never changes format, but only PNG, BMP, and TGA crops are lossless; JPEG and WebP crops are a same-format re-encode. |
| **Compress to a target size** | Works backwards from a file size (for example, under 200 KB) instead of a quality slider, narrowing quality, scale, chroma subsampling, and progressive encoding until it fits. |
| **Format conversion** | Decode and re-encode across JPG, PNG, WebP, BMP, and TGA. |
| **PDF page extraction** | Extract a chosen page of a PDF as an image, then run it through the rest of the pipeline. |
| **Images to PDF** | Assemble processed JPEGs into a single PDF, no server required. |

Because every operation lives in the same pipeline, they compose freely.
Resize into a crop, compress the result, convert the format, and hand it
straight to PDF export, without exporting and re-importing between steps.
When neither compression nor conversion runs, the output keeps the source's
original format rather than defaulting to something else.

## WebAssembly and codecs

Several operations are powered by WebAssembly: browser-compatible codecs for
JPEG, PNG, and WebP, PDFium for PDF rendering, and a native JPEG
optimization core (see [`imaging/native`](./imaging/native)) compiled to
WASM for the target-size compression path. The binaries ship as static
assets and load on demand. No native executable or backend is required.

## The `imaging` package

[`imaging/`](./imaging) is a standalone TypeScript package with its own
browser and Node entry points, so the same processing code that runs in the
app also runs directly in Node:

```text
imaging/
  src/
    compress.ts, convert/, pdfToImages.ts, jpegsToPdf.ts, printLayout.ts
    jpegopt-engine.ts
    browser and node codec implementations
  wasm/      compiled jpegopt WebAssembly engine
  native/    C source for rebuilding the JPEG optimization core
  test/      imaging engine tests
```

It is consumed as a local dependency (`"imaging": "file:./imaging"`), and
the app only ever imports its public interface, never its internals.

## Privacy model

Privacy is architectural here, not a checkbox in settings.

**Main pipeline:** your file never leaves the browser. There is no FitForm
upload endpoint in the image or PDF path. Processing happens locally, which
matters for photos, scanned documents, and other files you would rather not
send to a third-party server.

**Vault:** storage is your own Google Drive, not FitForm infrastructure.
Access is scoped to `drive.file`, which limits FitForm to files it created
and files you explicitly opened via Google's picker. The Drive access token
is cached in `sessionStorage`, so a page reload doesn't force you to
reconnect, but it never touches `localStorage` and disappears once the tab
is closed. A small, non-sensitive value, the cached Vault folder ID, is kept
in `localStorage` so it doesn't need to be looked up again on every visit.

## Project structure

```text
.
  src/
    components/    UI and pipeline controls
    engine/        Worker-based processing bridge
    drive/         Google Drive auth and API access
    state/         Pipeline state and configuration
    App.tsx
  imaging/         Reusable image/PDF processing package
  public/
    wasm/          Static WebAssembly assets
    fonts/         Self-hosted fonts
    privacy.html
    terms.html
  scripts/         Build and test utilities
  .github/workflows/  Deployment automation
```

## Getting started

Requires Node.js 18.17 or newer, and npm.

```bash
npm install         # installs deps, builds the imaging package
npm run dev         # start the dev server
npm run build       # production build
npm run preview     # preview the production build locally
```

## Deployment

FitForm builds to a static `dist/` directory that any static host can serve:

```bash
npm run build
```

For a GitHub Pages project site, set the base path first:

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```

A GitHub Actions workflow for automated deployment is included under
[`.github/workflows`](./.github/workflows).

## Design principles

- **Local first.** Process on-device whenever the browser can do the work.
- **Pipeline based.** Operations compose instead of living as separate tools.
- **Explicit results.** Always show the resulting dimensions and file size.
- **Responsive processing.** Expensive work belongs in a worker, not the UI thread.
- **Static by default.** Deployable without an application backend.
- **Reusable processing layer.** `imaging` stays independent of the React UI.

## Known limitations

- TGA output isn't natively previewable in most browsers or operating systems.
- Lossy re-encodes (JPEG, WebP) lose information, as always, including on a
  same-format crop.
- Large images and high-resolution PDF pages need meaningful memory on
  lower-end mobile devices.
- PDF rendering speed varies by device and browser.
- Vault needs an OAuth client configured for your deployment origin if you
  are self-hosting.
- WASM codecs add to the static bundle size, since the processing engines
  ship to the browser.
- Cancellation terminates and restarts the whole worker rather than
  stopping a single in-flight operation, since the underlying WASM calls
  run to completion once started.

## License

FitForm and the bundled `imaging` package are both released under the MIT
License. See [`LICENSE`](LICENSE). Third-party packages, fonts, and
WebAssembly modules remain subject to their own licenses.

## Acknowledgements

Built on [React](https://react.dev), [Vite](https://vitejs.dev),
[Tailwind CSS](https://tailwindcss.com), [Radix UI](https://www.radix-ui.com),
[jSquash](https://github.com/jamsinclair/jSquash) codecs, and
[PDFium](https://pdfium.googlesource.com/pdfium/).

---

<p align="center">
  <strong>FitForm</strong>: process your files locally, keep control of your documents.
</p>
