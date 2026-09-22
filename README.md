<p align="center">
  <img src="public/logo.svg" alt="FitForm" width="88">
</p>

<h1 align="center">FitForm</h1>

<p align="center">
  A client-side image and PDF workspace for resizing, cropping, compression,
  format conversion, printing, and document storage.
</p>

<p align="center">
  <a href="https://fitform.slek.dev/">Live application</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://fitform.slek.dev/privacy.html">Privacy</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://fitform.slek.dev/terms.html">Terms</a>
</p>

---

## Overview

FitForm is a browser based image and PDF toolkit built around one simple idea:

**Give people precise control over their files without making them upload those
files to a processing server.**

It combines a clean visual workflow with a processing engine capable of handling
image resizing, cover cropping, target-size compression, format conversion,
PDF page extraction, A4 print preparation, and JPEG-to-PDF creation.

The application is completely static. There is no FitForm application server
sitting between the browser and the files being processed. The main processing
pipeline runs locally in the browser, with expensive work moved into a Web
Worker so the interface can remain responsive.

FitForm also includes an optional Vault. Vault uses the user's own Google Drive
as the storage layer, allowing documents to be saved without introducing a
FitForm hosted database or file storage service.

<p align="center">
  <a href="https://fitform.slek.dev/">
    <strong>Open FitForm</strong>
  </a>
</p>

## What FitForm does

FitForm is organized around a processing pipeline rather than a collection of
unrelated one-off tools.

A file enters the application, its metadata is inspected, the selected
operations are assembled into a pipeline, and the processing engine executes
those operations in order. The result is then returned to the interface with
its final dimensions, format, and file size.

This makes it possible to combine operations such as:

```text
Resize -> Crop -> Compress -> Convert -> Print/PDF
```

The exact pipeline is determined by the options selected by the user.

### Resize

Resize changes an image to a specific width and height.

The imaging engine supports multiple resampling methods, including:

- Triangle
- Catmull-Rom
- Mitchell
- Lanczos3
- HQX
- Magic Kernel variants

Different resampling methods have different characteristics when reducing or
enlarging images. FitForm exposes these choices so the resize operation is not
limited to a single interpolation method.

### Crop

Crop uses the requested output dimensions as the target frame and performs a
cover-style crop against the decoded image pixels.

The crop can be positioned using anchors such as:

- Center
- Top
- Bottom
- Left
- Right

This is useful when an image needs to fit an exact aspect ratio without
stretching.

Cropping is performed as part of the processing pipeline, so it can be
combined with resizing and compression rather than requiring a separate export
and re-upload cycle.

### Compress to a target size

Instead of asking for an arbitrary quality number, FitForm can work backwards
from a target file size.

For JPEG compression, the imaging engine searches for an encoding that fits
the requested size. It evaluates different quality settings and progressively
narrows the search rather than relying on a single fixed quality value.

The compression system can use:

- A browser Canvas based encoder
- A bundled WebAssembly JPEG optimization engine
- Quality bounds
- Image scale reduction when necessary
- Chroma subsampling
- Progressive JPEG encoding

This is particularly useful for workflows where the requirement is expressed
as "make this image smaller than 200 KB" rather than "use JPEG quality 70".

### Format conversion

FitForm can convert between:

- JPG
- PNG
- WebP
- BMP
- TGA

Conversion is implemented as a decode and re-encode operation. The processing
engine keeps format handling separate from the application interface, allowing
the same imaging functionality to be used by the browser pipeline and the
Node based test environment.

### PDF to image

A PDF can be opened and a page can be extracted as an image.

PDF rendering is handled through the browser imaging layer rather than by
sending the document to a remote conversion service. The interface exposes
page selection so a specific page can be brought into the image workflow.

Once extracted, that page can be resized, cropped, compressed, converted, or
prepared for printing like any other image.

### Images to PDF

JPEG images can be assembled into a PDF document.

This makes it possible to take processed images and create a compact document
without depending on a server side PDF generator.

### A4 print preparation

FitForm can prepare an image for A4 printing at 300 DPI.

The print layout stage handles:

- A4 page dimensions
- Print resolution
- Margins
- Image sizing
- Alignment
- Output quality

The result is a print-oriented canvas that can then be exported as part of
the final workflow.

## How the processing engine works

The user interface and the processing engine are intentionally separated.

The React application is responsible for the interface, pipeline controls,
file selection, progress display, and result presentation.

The `imaging` package contains the actual image and PDF operations.

The application communicates with that package through a single Web Worker.

```text
Browser UI
    |
    v
Pipeline configuration
    |
    v
Engine client
    |
    v
Web Worker
    |
    v
Imaging engine
    |
    +-- Resize
    +-- Crop
    +-- Compress
    +-- Convert
    +-- PDF rendering
    +-- Print layout
    +-- PDF creation
    |
    v
Processed file
    |
    v
Preview, metadata, download
```

The worker boundary is important because image compression and PDF rendering can
be computationally expensive.

A target-size JPEG compression may require multiple encoding attempts while
the engine searches for an appropriate quality setting. PDF rendering can also
require substantial CPU and memory, especially for large pages.

Keeping this work away from the main browser thread prevents these operations
from unnecessarily blocking the interface.

## The imaging package

The `imaging/` directory is a standalone TypeScript package used by FitForm.

It contains the reusable processing layer rather than application-specific UI
code.

Its responsibilities include:

```text
imaging/
|
+-- src/
|   +-- compress.ts
|   +-- convert/
|   +-- pdfToImages.ts
|   +-- jpegsToPdf.ts
|   +-- printLayout.ts
|   +-- jpegopt-engine.ts
|   +-- browser codecs
|   +-- node codecs
|
+-- wasm/
|   +-- jpegopt WebAssembly engine
|
+-- native/
|   +-- source for rebuilding the JPEG optimization core
|
+-- test/
    +-- imaging engine tests
```

The package has separate browser and Node entry points. This allows the same
core processing concepts to be exercised in the browser application and in
automated tests without coupling the UI to implementation details.

It is included in the repository as a local npm dependency:

```json
"imaging": "file:./imaging"
```

The application therefore imports the package through its public interface
instead of reaching directly into its internal source files.

## WebAssembly and codecs

Several image and PDF operations are powered by WebAssembly.

FitForm uses browser compatible codec implementations for formats such as
JPEG, PNG, and WebP, together with PDFium based PDF rendering.

The JPEG compression path also includes a native optimization core compiled
to WebAssembly. This gives the browser access to a dedicated JPEG compression
implementation without requiring a native executable on the user's device.

The WebAssembly binaries are served as static assets and loaded by the worker
when the corresponding processing functionality is initialized.

The application does not need a backend to execute these operations.

## Privacy model

Privacy is a core part of the architecture rather than a separate upload
setting.

### Local processing

For the main image and PDF tools, the selected files are processed in the
browser.

The normal workflow is:

```text
Your file
   |
   v
Your browser
   |
   v
Local processing
   |
   v
Result
```

There is no FitForm upload endpoint involved in the image and PDF pipeline.

This is useful for photographs, scanned documents, identity documents, and
other files that users may not want to send to a third-party processing
server.

### Vault

Vault is an optional part of FitForm.

When enabled, it uses Google Drive as the storage layer. Files are stored in
the user's own Drive rather than in FitForm infrastructure.

FitForm requests Google's `drive.file` scope. This limits the application's
Drive access to files created by the application and files the user explicitly
opens through Google's file picker.

The Google access token is kept in memory for the current page session. It is
not stored in `localStorage` or `sessionStorage`.

FitForm does not operate a separate backend solely for Vault.

## Static architecture

FitForm is designed to be deployable as a static website.

The production application consists of:

- HTML
- JavaScript
- CSS
- WebAssembly assets
- Static legal pages
- Client-side application code

There is no requirement for a traditional application server.

A deployment can therefore be hosted through services such as GitHub Pages,
a static hosting provider, or a custom domain.

The current production deployment is:

https://fitform.slek.dev/

## Project structure

The repository is divided into a few clear areas:

```text
.
+-- src/
|   +-- components/       UI and pipeline controls
|   +-- engine/           Worker based processing bridge
|   +-- drive/            Google Drive authentication and API access
|   +-- state/            Pipeline state and configuration
|   +-- App.tsx           Application composition
|
+-- imaging/              Reusable image/PDF processing package
|
+-- public/
|   +-- wasm/             Static WebAssembly assets
|   +-- fonts/            Self-hosted fonts
|   +-- privacy.html      Privacy page
|   +-- terms.html        Terms page
|
+-- scripts/              Build and test utilities
|
+-- .github/
|   +-- workflows/        Deployment automation
|
+-- index.html
+-- package.json
+-- vite.config.ts
```

## Getting started

Requirements:

- Node.js 18.17 or newer
- npm

Install the project:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Testing

FitForm includes tests for both application behavior and the processing
engine.

Run the complete test suite:

```bash
npm test
```

The test setup covers three important areas:

### Pipeline behavior

The pipeline tests verify that UI choices are translated into the expected
processing configuration.

This includes decisions around resizing, cropping, compression, conversion,
and final output handling.

### Worker lifecycle

The client tests exercise the communication layer between the application and
the processing worker.

They cover situations such as:

- Worker startup
- Worker messages
- Errors
- Cancellation
- Worker restart behavior

### Imaging smoke tests

The smoke tests exercise the actual imaging operations, including resizing,
compression, format conversion, print layout, JPEG to PDF creation, and PDF
page handling.

This provides a functional check across the processing stack rather than only
testing individual UI functions.

## Deployment

FitForm can be deployed as a static application.

For the custom domain used by the project:

```bash
npm run build
```

The generated `dist/` directory can then be served by a static hosting
provider.

For a GitHub Pages project site, provide the repository path when building:

```bash
VITE_BASE_PATH=/repository-name/ npm run build
```

The repository also includes a GitHub Actions workflow for automated
deployment.

## Design principles

FitForm is built around a few practical principles.

### Local first

Files should be processed on the device whenever the browser can do the work.

### Pipeline based

Operations should be composable. Resizing, cropping, compression, conversion,
and output preparation should work together instead of forcing users through
separate tools.

### Explicit results

The interface exposes the resulting dimensions and file size so users can
understand what happened to their file.

### Responsive processing

Expensive work belongs in a worker, not on the browser's main UI thread.

### Static by default

The core application should remain deployable without maintaining an
application backend.

### Reusable processing layer

The imaging functionality is kept independent from the React interface so it
can be tested and reused separately.

## Current limitations

Some browser and format limitations are inherent to the technologies used:

- TGA files can be generated, but many browsers and operating systems do not
  provide native TGA previews.
- Lossy formats such as JPEG and WebP can lose information when they are
  re-encoded.
- Large images and high resolution PDF pages can require significant memory.
- PDF rendering performance depends partly on the device and browser.
- Vault requires Google authentication and an OAuth client configured for the
  deployment origin when running a custom deployment.
- WebAssembly assets add to the size of the static application because the
  processing engines are shipped to the browser.

## License

FitForm is released under the MIT License.

The repository also contains the `imaging` package, which is independently
licensed under the MIT License.

See [`LICENSE`](LICENSE) for the full license text.

Third party packages, fonts, WebAssembly modules, and other bundled
dependencies remain subject to their respective licenses. Their license terms
are not replaced by the FitForm license.

## Acknowledgements

FitForm builds on a number of open source projects and browser technologies,
including React, Vite, Tailwind CSS, Radix UI, jsquash codecs, PDFium, and
WebAssembly based processing components.

Their respective licenses and notices remain applicable to the components
they provide.

## Links

- Website: https://fitform.slek.dev/
- Privacy: https://fitform.slek.dev/privacy.html
- Terms: https://fitform.slek.dev/terms.html
- Imaging package: `./imaging`
- License: [`LICENSE`](LICENSE)

---

<p align="center">
  <strong>FitForm</strong><br>
  Process your files locally. Keep control of your documents.
</p>
