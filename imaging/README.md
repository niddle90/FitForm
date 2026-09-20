# imaging

Compress images to a **target file size**, convert between JPEG/PNG/WebP/BMP/TGA, extract PDF pages as images, read JPEG/EXIF metadata, and lay images out on an A4 print sheet — a small set of pure, well-tested TypeScript functions that run identically in the browser and in Node.js.

**imaging is a hybrid suite.** Four of its five tools (`printLayout`, `convertFormat`, `jpegsToPdf`, `pdfToImages`) still follow the project's original rule: bring your own codecs (jSquash + pdfium, exact versions pinned below), imaging brings the algorithm, the input validation, and the tests — **no WASM bundled**. The fifth, `compress`, is now hybrid by design: its original zero-WASM Canvas engine still exists and is still the default for non-JPEG input, but it's joined by a small, **self-built, byte-for-byte-verified native WASM compression core** (`jpegopt`) for JPEG-in/JPEG-out work, bundled directly in this package. You pick which engine per call, or let `'auto'` pick for you. See [Choosing a compress engine](#choosing-a-compress-engine) for why this is the one deliberate exception to "no bundled WASM," and what you get for it.

## Why not just use jSquash/pdfium (and a JPEG library) directly?

- **`compress`** — hits an *exact target file size* (for form/document-upload limits), not just "compress at quality N." Two engines: a browser-Canvas one that works on any input format a canvas can decode, and a native WASM one that's deterministic, faster, and exposes controls (explicit output dimensions with anchored cropping, chroma subsampling, progressive encoding, a configurable quality floor) neither a canvas nor a naive jSquash call gives you.
- **`printLayout`** — composites an image onto a full A4-at-300dpi canvas with cm-based margins/centering, for print-ready output.
- **`pdfToImages`** — renders PDF pages to JPEG via pdfium, with page-range selection and dimension caps.
- **`jpegsToPdf`** — wraps JPEGs into a minimal valid PDF, and parses JPEG/EXIF metadata (dimensions, orientation) without a full image decode.
- **`convertFormat`** — format conversion with format auto-detection from magic bytes.
- Every function validates its own input and rejects the malformed/adversarial cases a naive port of a decoder would silently mishandle — see [Hardening](#hardening), which is not a footnote here, it's a big part of the reason this package exists as a layer instead of you calling codecs directly.

## Install

```sh
npm install imaging
```

Four tools need codecs you install yourself (exact versions — see [Install the pinned codecs](#install-the-pinned-codecs) below). `compress`'s native engine needs nothing extra: `jpegopt.wasm` ships inside `imaging` itself.

```ts
// Zero extra installs for this path:
import { compress } from 'imaging';
import { createJpegOptEngineNode } from 'imaging/node'; // or .../browser

const engine = await createJpegOptEngineNode();
const out = await compress(jpegBytes, { targetKb: 200, wasmEngine: engine });
```

### Install the pinned codecs

Needed for `printLayout`, `convertFormat`, `jpegsToPdf`, `pdfToImages`, and for `compress`'s Canvas engine on non-JPEG input:

```sh
npm install @jsquash/jpeg@1.6.0 @jsquash/png@3.1.1 @jsquash/webp@1.5.0 @jsquash/resize@2.1.1 @embedpdf/pdfium@2.15.0
```

These are declared as `peerDependencies` — install exactly these versions. They're pinned, not range-matched, because this package's test suite is verified against these exact builds; newer versions may work but haven't been checked against the hardening tests below.

If you'll use the Canvas engine from Node.js (not just the browser), also install the optional peer:

```sh
npm install @napi-rs/canvas
```

If you only ever call `compress` with the native WASM engine on JPEG input, you can skip every install in this section entirely.

## Five entry points

| Import from | Contains | Why separate |
|---|---|---|
| `imaging` | All algorithms (`compress`, `printLayout`, `convertFormat`, `jpegsToPdf`, `pdfToImages`), types, `VaultError`, size-limit constants, `createJpegOptEngineFromBinary` | Cross-platform, zero environment-specific code |
| `imaging/browser` | `createBrowserCodecs()`, `browserCanvasProvider`, `createJpegOptEngineBrowser()` | Uses `fetch`/`OffscreenCanvas` — kept out of the root so a Node bundler never tries to resolve them |
| `imaging/node` | `createNodeCodecs()`, `nodeCanvasProvider`, `createJpegOptEngineNode()` | Uses `node:fs` — kept out of the root so a browser bundler never tries to resolve `fs` |

`createJpegOptEngineBrowser`/`Node` are further split internally into their own modules (`browser-jpegopt.ts`/`node-jpegopt.ts`) with **zero import of `@jsquash/*` or `@embedpdf/pdfium`** — if the only thing you use is `compress`'s WASM engine, none of the five peer-dependency packages above ever needs to be installed, let alone bundled.

## Quick start (browser)

```ts
import { compress } from 'imaging';
import { createJpegOptEngineBrowser } from 'imaging/browser';

// jpegopt.wasm ships inside this package; most bundlers (Vite, webpack 5,
// esbuild) auto-detect the `new URL(..., import.meta.url)` pattern this
// loader uses internally and copy the asset for you -- no manual static-
// asset step needed, unlike the jSquash/pdfium assets below.
const engine = await createJpegOptEngineBrowser();

const compressed = await compress(sourceJpegBytes, { targetKb: 200, wasmEngine: engine });
```

Need `printLayout`/`convertFormat`/`jpegsToPdf`/`pdfToImages`, or `compress` on non-JPEG input, too:

```ts
import { createBrowserCodecs } from 'imaging/browser';

// Host these 7 files as static assets (see "WASM asset hosting" below).
const assetBaseUrl = new URL('/wasm/', location.origin);
const codecs = await createBrowserCodecs({ assetBaseUrl });
```

## Quick start (Node.js)

```ts
import { compress } from 'imaging';
import { createJpegOptEngineNode } from 'imaging/node';

const engine = await createJpegOptEngineNode(); // reads the bundled jpegopt.wasm via fs
const compressed = await compress(jpegBytes, { targetKb: 200, wasmEngine: engine });
```

```ts
import { pdfToImages } from 'imaging';
import { createNodeCodecs } from 'imaging/node';

const codecs = await createNodeCodecs(); // reads the pinned jSquash/pdfium wasm via fs.readFileSync
const pages = await pdfToImages(pdfBytes, codecs, { page: 1 });
```

## Choosing a `compress` engine

```ts
compress(bytes, { targetKb: 200, engine: 'auto' | 'wasm' | 'canvas', /* ... */ })
```

| | `'canvas'` | `'wasm'` |
|---|---|---|
| Input formats | Anything a canvas can decode (JPEG, PNG, WebP, GIF, ...) | JPEG only |
| WASM required | None | `jpegopt.wasm` (bundled, ~420KB) |
| Determinism | Depends on the host's own JPEG encoder — same input+target can land on a different pixel width on two browsers (never a different *byte budget*; see note below) | Byte-for-byte identical across every browser and OS — same libjpeg-turbo build everywhere |
| Speed | A canvas round-trip (decode, draw, re-encode) per bisection step | Direct libjpeg-turbo calls, no canvas, typically faster |
| Explicit output dimensions | No — width always follows the aspect-ratio-preserving downscale the bisection needs | Yes — `width`/`height`, including a "cover + anchored crop" mode |
| Chroma subsampling / progressive | No (whatever the host encoder defaults to) | Yes, both configurable |
| Quality floor / retry budget | Fixed algorithm (matches the original `xpress.c` exactly) | Configurable (`minQuality`, `maxScaleTries`) |
| Malformed input | Decode failure surfaces via the host's own decoder — see [Security notes](#security-notes) for a specific finding here | Decode failure caught internally (libjpeg's `setjmp`/`longjmp`), always a clean `VaultError` |

`engine: 'auto'` (the default) picks `'wasm'` when you supplied a `wasmEngine` **and** the input looks like a JPEG (magic bytes `FF D8`); otherwise it uses `'canvas'`. This means dropping a `wasmEngine` into existing code upgrades JPEG-in/JPEG-out calls with no other change, while non-JPEG input keeps working exactly as before.

**On the canvas engine's determinism note:** its bisection loop never assumes a fixed quality→size curve — every iteration measures the *actual* encoded blob and adjusts from that real measurement, exactly like the original `xpress.c` CLI it was ported from measured real file sizes with `get_size_kb()`. That makes "final size ≤ target" true on every browser by construction, re-verified at runtime, not assumed from a table. The one thing it can't guarantee across browsers is *which pixel width* got there, since that depends on how many bytes the host's own JPEG encoder needs for a given quality — a deliberate, documented tradeoff, not an oversight.

## API

### `compress(bytes, options)`

```ts
type CompressEngine = 'auto' | 'wasm' | 'canvas';

interface CompressOptions {
  targetKb: number;                    // required
  engine?: CompressEngine;              // default 'auto'
  resolveWithObject?: boolean;         // default false -- see below
  verbose?: boolean;
  onLog?: (msg: string) => void;

  // canvas engine
  canvasProvider?: CanvasProvider;     // defaults to browserCanvasProvider

  // wasm engine
  wasmEngine?: JpegOptEngine;          // required for engine: 'wasm'
  width?: number;
  height?: number;
  fixedDimension?: boolean;
  minQuality?: number;                 // default 20
  maxScaleTries?: number;              // default 5
  subsampling?: '4:4:4' | '4:2:2' | '4:2:0' | '4:1:1'; // default '4:4:4'
  progressive?: boolean;               // default false
  cropAnchor?: 'center' | 'top' | 'bottom' | 'left' | 'right'; // default 'center'
  allowMiss?: boolean;                 // default false -- see below
}

compress(bytes: Uint8Array, options: CompressOptions): Promise<Uint8Array>
// or, with resolveWithObject: true:
compress(bytes: Uint8Array, options): Promise<{
  data: Uint8Array;
  engine: 'wasm' | 'canvas';
  width: number;
  height: number;
  quality?: number;      // wasm engine only
  metTarget?: boolean;   // wasm engine only (always true for canvas -- see allowMiss)
}>
```

**Dimension handling (wasm engine):**

| Options given | Behavior |
|---|---|
| `fixedDimension: true` | Keep the source's native pixel size, ignore `width`/`height` entirely |
| `width` only | Resize to that width; height follows the source aspect ratio |
| `height` only | Mirror of the above |
| `width` + `height` | **Cover** resize: scale to fully fill the box, then crop the overflow, anchored per `cropAnchor` |
| none of the above | Same as `fixedDimension: true`, *and* the autoscale-retry fallback (`maxScaleTries`) is available if the quality floor alone can't hit the target |

**`resolveWithObject`** (default `false`, same convention `sharp` uses): get back the richer `{ data, engine, width, height, quality?, metTarget? }` instead of a bare `Uint8Array`. Existing code that treats the return value as raw bytes is unaffected either way.

**`allowMiss`** (default `false`): if the wasm engine can't reach `targetKb` even at `minQuality` (and, when dimensions weren't pinned, even after `maxScaleTries` shrink rounds), the default is to throw `VaultError('CONSTRAINT', ...)` — matching the canvas engine's uncompromising "final size ≤ target, or a clean error" contract. Set `allowMiss: true` to get the closest result back instead; check `metTarget` to see whether it actually hit the budget.

Throws `VaultError('compress', 'CONSTRAINT')` on a miss (both engines, unless `allowMiss`), `VaultError('compress', 'FORMAT')` on undecodable input, `VaultError('compress', 'ARGS')` on invalid options (e.g. `engine: 'wasm'` with no `wasmEngine`).

### The `jpegopt` native engine

```ts
import { createJpegOptEngineFromBinary } from 'imaging'; // universal
import { createJpegOptEngineBrowser } from 'imaging/browser';
import { createJpegOptEngineNode } from 'imaging/node';

interface JpegOptEngine {
  run(input: Uint8Array, options: JpegOptRunOptions): JpegOptResult | null;
}
```

`run()` is synchronous (the whole search completes in one JS turn — no reentrancy hazard) and takes the exact same options `compress` forwards to it (`targetKb`, `width`, `height`, `fixedDimension`, `minQuality`, `maxScaleTries`, `subsampling`, `progressive`, `cropAnchor`). Returns `null` — never throws — when the input isn't a decodable JPEG; `compress` is what turns that into a `VaultError`. Use the engine directly (bypassing `compress`) if you want the raw `{ data, quality, width, height, metTarget }` without the suite's error-wrapping conventions.

**How it works, in one paragraph:** JPEG size vs. quality is monotonic for a fixed image, so finding the highest quality under a byte budget is a plain bisection on *encode size alone* — about 7 encode passes, no decode-back, no perceptual metric. This reproduces the original `xpress.c` tool's exact algorithm against real libjpeg-turbo instead of approximating it through a browser's own JPEG encoder, which is what makes the wasm engine's output deterministic across platforms in a way the canvas engine structurally can't be. Full internals, every option's C-level behavior, and known simplifications (bilinear resize, no perceptual metric) are documented in `native/jpegopt-fast-core/README.md`.

**Why this WASM is bundled when the rest of the suite deliberately isn't:** it's small in scope (libjpeg-turbo plus ~450 lines of purpose-built C — a much smaller trust surface than vendoring a general-purpose image library), it's been **verified byte-for-byte identical to a native (non-WASM) build across every option it exposes** (see `scripts/build-wasm.sh`'s tail for how to reproduce that check yourself), and — unlike the jSquash/pdfium assets — there's no "which upstream version" pinning question, since this project *is* the upstream for it.

### `printLayout(bytes, codecs, options)`
Lays an image out on a full A4-at-300dpi canvas.
```ts
printLayout(bytes: Uint8Array, codecs: VaultCodecs, options: {
  widthCm?: number; heightCm?: number;   // mutually exclusive
  leftCm?: number; rightCm?: number; center?: boolean; // mutually exclusive
  topCm?: number;
  quality?: number; // 0-100
}): Promise<Uint8Array>
```

### `convertFormat(bytes, codecs, options)`
Converts between jpeg/png/webp/bmp/tga.
```ts
convertFormat(bytes: Uint8Array, codecs: VaultCodecs, options: {
  format: 'jpeg' | 'png' | 'webp' | 'bmp' | 'tga';
  quality?: number;
}): Promise<Uint8Array>
```
`detectFormat(bytes)`, `formatFromString(s)`, and `formatFromPath(path)` are also exported for format resolution.

### `pdfToImages(bytes, codecs, options)`
Renders PDF pages to JPEG.
```ts
pdfToImages(bytes: Uint8Array, codecs: VaultCodecs, options?: {
  page?: number;        // omit to extract every page
  quality?: number;
  maxRenderDim?: number;
}): Promise<Array<{ pageNumber: number; jpeg: Uint8Array }>>
```

### `jpegsToPdf(images)` / `parseJpegMeta(bytes)`
```ts
jpegsToPdf(images: Uint8Array[]): JpegsToPdfResult // { pdf: Uint8Array } -- synchronous, one page per image
parseJpegMeta(bytes: Uint8Array): JpegMeta | null // { w, h, orient, cs }
```

### Errors
Every function throws `VaultError`, never a raw codec exception:
```ts
class VaultError extends Error {
  tool: 'compress' | 'printLayout' | 'convertFormat' | 'jpegsToPdf' | 'pdfToImages' | 'pipeline';
  code: 'ARGS' | 'FORMAT' | 'CONSTRAINT' | 'LIMIT';
}
```

### Size limits
```ts
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, assertSaneImageDimensions } from 'imaging';
```
`assertSaneImageDimensions` is what every decoder in this package calls before allocating a pixel buffer — see [Hardening](#hardening).

## WASM asset hosting

**`jpegopt.wasm`** (compress's native engine): ships inside `imaging` at `wasm/jpegopt.wasm`. `createJpegOptEngineBrowser()`/`createJpegOptEngineNode()` locate it automatically relative to the installed package — nothing to copy for most setups. Pass `assetUrl`/`wasmPath` to override if you'd rather serve it from your own CDN.

**The seven jSquash/pdfium files** (everything else): these are peer-dependency assets living in `node_modules`, so there's no equivalent auto-discovery — `createBrowserCodecs()` fetches them from wherever `assetBaseUrl` points, and you copy them there at build time (a Vite `viteStaticCopy` config or equivalent):

```
mozjpeg_dec.wasm       — @jsquash/jpeg/codec/dec/mozjpeg_dec.wasm
mozjpeg_enc.wasm       — @jsquash/jpeg/codec/enc/mozjpeg_enc.wasm
squoosh_png_bg.wasm    — @jsquash/png/codec/pkg/squoosh_png_bg.wasm
webp_dec.wasm          — @jsquash/webp/codec/dec/webp_dec.wasm
webp_enc.wasm          — @jsquash/webp/codec/enc/webp_enc.wasm
squoosh_resize_bg.wasm — @jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm
pdfium.wasm            — @embedpdf/pdfium/dist/pdfium.wasm
```

All eight `.wasm` files (these seven, plus `jpegopt.wasm` if you host it yourself instead of relying on the default `import.meta.url` resolution) must be served as **plain static files**, not inlined/bundled, with `Content-Type: application/wasm` — check this explicitly; a misconfigured static host serving `application/octet-stream` will silently break `WebAssembly.instantiateStreaming`. Pass custom filenames via `createBrowserCodecs({ assetBaseUrl, filenames: { ... } })` if you rename any of the seven during your build.

## Building the native engine from source

`wasm/jpegopt.{js,wasm}` is a build artifact, not hand-written. The C source (`native/jpegopt-fast-core/`) and the exact recipe that produces the shipped binary (`scripts/build-wasm.sh`) are both in this repo:

```sh
bash scripts/build-wasm.sh   # rebuilds wasm/jpegopt.{js,wasm} from source
npm test                     # verifies the result
```

You'd want to do this to change the C engine itself (new options, a different resize filter), to rebuild against a newer libjpeg-turbo, or just to audit that the shipped binary matches the shipped source. The script documents, inline, two real problems hit while producing this build and exactly how each was resolved (not worked around by hiding the symptom):

1. **A wasm32 cross-compile miscomputes `SIZEOF_SIZE_T`.** CMake's `check_type_size()`, run through Emscripten's cross-compile emulator, computed `9` instead of the correct `4` for wasm32 — libjpeg-turbo's `jchuff.c` bit-buffer packing depends on this being exactly right, and a wrong value doesn't corrupt silently; it fails the build outright (`#error Cannot determine word size`), which is how this got caught rather than shipped. Fixed two ways for redundancy: the known-good header already in `native/jpegopt-fast-core/include/` is used in place of the miscomputed one, *and* `jchuff.c` gets a small patch recognizing `__wasm32__` explicitly, so a future plain rebuild that regenerates the header from scratch doesn't quietly reintroduce the bug.
2. **Emscripten's Node-vs-browser output and Node's ESM loader disagree with each other, in two different ways depending which output mode you pick.** The default UMD output guards its `module.exports = ...` behind `typeof module === "object"`, which is false under this package's `"type": "module"` — the factory function ends up exported nowhere, silently. The seemingly-obvious fix, building with `-sEXPORT_ES6=1` for real `export default` syntax, trades that bug for a different one: this Emscripten version's ES6 output still computes its Node-environment `scriptDirectory` via the CommonJS-only `__dirname` global unconditionally, which throws `ReferenceError` under a genuine ESM loader. (A quick `node -e "import(...)"` smoke test can miss this entirely — `-e` evaluates in a CJS wrapper that happens to define `__dirname` anyway, masking the bug; this project's actual test suite, loading the module the way a real consumer would, is what caught it.) The fix that avoids patching Emscripten's generated code at all: keep the default CJS/UMD output, and ship a `wasm/package.json` with `{"type": "commonjs"}` — Node's own documented per-directory override — so this one vendored file is correctly treated as CommonJS regardless of the outer package's module type.

**Verifying a build:** the strongest check available isn't a unit test, it's a diff. Compile `native/jpegopt-fast-core/src/jpegopt.c` a second time as a plain native binary (`cc -O2 -o jpegopt_native src/jpegopt.c -ljpeg -lm`), run the same input through both builds with identical flags, and `cmp` the outputs — they should be byte-for-byte identical, because the WASM build changes nothing about the algorithm, only the target triple. That's exactly how the shipped `wasm/jpegopt.wasm` was verified, across every option this module exposes (subsampling, progressive, crop anchors, quality floor), not just the default path.

## Security notes

Found while extending this project's own test suite, not something we went looking for: feeding a sufficiently-malformed-but-PNG-signature-prefixed byte buffer to `@napi-rs/canvas`'s `loadImage()` — the real native decoder behind `nodeCanvasProvider` — **segfaults the Node process** rather than rejecting the promise. Reproduced in isolation, with zero involvement from any code in this repository:

```ts
import { loadImage } from '@napi-rs/canvas';
const bytes = new Uint8Array(20000);
bytes.set([0x89, 0x50, 0x4e, 0x47], 0); // PNG magic, garbage body
await loadImage(Buffer.from(bytes)); // segfaults the process
```

This predates and is unrelated to the hybrid-engine changes in this revision — it's a property of the pinned `@napi-rs/canvas` version itself, not of `imaging`'s code. It's documented here, prominently, rather than silently, because:

- It means `nodeCanvasProvider` (and by extension `compress`'s canvas engine, and `convertFormat`, wherever they touch attacker-controlled bytes on a server) is **not currently a safe decoder to expose directly to untrusted uploads on Node** without an additional isolation boundary (a subprocess or sandboxed worker you can crash-and-restart), whatever this package's own JS-level input validation does.
- It's exactly the kind of gap this package's own [Hardening](#hardening) philosophy exists to surface, so hiding it here would contradict the project's own stated standard.
- It's a concrete, verified reason `compress`'s wasm engine is the better default for server-side JPEG handling specifically: libjpeg-turbo's own error path is caught internally via `setjmp`/`longjmp`, and this project's test suite includes a real (non-mocked) adversarial-input case proving the wasm engine returns a clean `VaultError('FORMAT')` on the same class of malformed input instead.

If you rely on `nodeCanvasProvider` for untrusted input today, treat this as a reason to prioritize isolating that specific call, watch for an upstream fix, or prefer the wasm engine wherever your input is JPEG.

## Hardening

This package's test suite (`npm test`, 39 cases, run against real pinned/compiled WASM binaries — jSquash, pdfium, *and* jpegopt — not mocks) includes a dedicated adversarial-input section, because the bugs worth documenting are the ones a naive integration wouldn't catch:

- **Unbounded declared dimensions.** A BMP/TGA header, or a PDF's `MediaBox`, can declare arbitrary width/height. Without a cap, a tiny malicious/corrupt file can trigger a multi-gigabyte allocation attempt (denial of service) or — in a 32-bit `size_t` context — an integer-overflow-driven undersized allocation followed by an out-of-bounds write. Every decoder in this package calls `assertSaneImageDimensions` (in `limits.ts`) before allocating, with both a per-dimension cap and a total-pixel cap.
- **Declared dimensions vs. actual buffer length.** A BMP/TGA header can claim a large image while the file is truncated to a few bytes. Without a check, this doesn't crash — it silently returns a fabricated all-black image with no error, which is worse than a crash for a document-processing pipeline (a corrupted upload passes through unnoticed). `decodeBmp`/`decodeTga` verify the buffer is actually long enough for the declared dimensions before reading.
- **Unsigned vs. signed bitfield decoding.** JPEG EXIF IFD offsets are an unsigned 32-bit field; JavaScript's `<<` operator produces a signed result, so a legitimate large offset can come out negative and desync the parser. Fixed with an explicit `>>> 0`.
- **Silent parameter pass-through.** Out-of-range JPEG quality values, and print dimensions that round to 0px, are rejected explicitly rather than silently clamped or passed through to the codec.
- **Error-contract leaks.** A raw `DOMException`/codec-internal error is never allowed to escape a public function — everything is caught and re-thrown as a categorized `VaultError`. This is checked for both engines behind `compress` now: a throwing `CanvasProvider` and genuinely malformed bytes fed to the wasm engine are both dedicated test cases.
- **A real crash found, not just a hypothetical one.** See [Security notes](#security-notes) above — the wasm engine's `setjmp`/`longjmp`-based error handling is verified, in this suite, to survive input that segfaults the alternative native decoder this package also supports.

If you're integrating a new codec binding or extending a decoder, `test/run.ts`'s "hardening" section is the place to add the next adversarial case, not an afterthought at the end.

## Development

```sh
npm install
npm run typecheck
npm test         # runs against real jSquash/pdfium/jpegopt wasm, no mocks
npm run build
npm run build:wasm   # rebuild wasm/jpegopt.{js,wasm} from native/ source -- see above
```

## License

MIT — see [LICENSE](./LICENSE).
