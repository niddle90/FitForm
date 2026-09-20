# jpegopt-fast (core)

> **This copy lives inside imaging** (`native/jpegopt-fast-core/`), as
> the vendored source behind compress's optional WASM engine. The compiled
> output is shipped at `wasm/jpegopt.{js,wasm}`; see
> `scripts/build-wasm.sh` at the repo root for the exact, reproducible
> build recipe (this file documents the *engine*, that script documents
> *this specific build*). Everything below applies whether you use this
> source standalone or through imaging.

A minimal, fast engine for hitting a **target JPEG file size**. Given an
input JPEG and a byte budget, it finds the highest JPEG quality that still
fits under that budget, in about 7 encode passes.

This package is the portable core: a single C source file plus the
libjpeg-turbo headers it was written against. There is no prebuilt binary,
no bundled `libjpeg.a`, and no demo page — link it against libjpeg (or
libjpeg-turbo) on whatever target you're building for (native, wasm, or
otherwise) and call it from your own CLI, service, or app shell.

## How it works

JPEG size vs. quality is monotonic (non-decreasing) for a fixed image, so
finding the best quality under a byte budget is a plain **bisection on
encode size alone** — no decode-back, no perceptual metric (MS-SSIM/GMSD),
no multi-pass comparison. Each encode of a several-megapixel image takes a
few tens of milliseconds, so the whole search finishes in well under a
second, single-threaded.

If width/height aren't pinned and even the quality floor (20 by default,
configurable — see "Customization knobs" below) can't hit the target, it
falls back to shrinking the image in a few bounded steps and retrying,
rather than producing an unusably ugly quality-1 result.

### Dimension handling

| Flags                          | Behavior                                                                 |
|---------------------------------|---------------------------------------------------------------------------|
| `--fixed-dimension`             | Keep the source's native pixel size, ignore `--width`/`--height`.        |
| `--width W` only                | Resize to width `W`; height follows the source aspect ratio.             |
| `--height H` only               | Mirror of the above.                                                     |
| `--width W --height H`          | **Cover** resize: scale to fully fill the `W x H` box, then crop the overflow, anchored per `--crop-anchor` (default: center). |
| (none of the above)             | Same as `--fixed-dimension`.                                              |

### Encoding choices

- Baseline sequential JPEG by default, or progressive with `--progressive`.
- **4:4:4 (no chroma subsampling)** by default — keeps fine color detail;
  the size cost is small at the quality levels this tool tends to land on.
  `--subsampling 422|420|411` trade color detail for smaller files when the
  byte budget is tight enough that quality alone can't buy back the bytes
  4:4:4 costs.
- Optimized Huffman tables (`optimize_coding`) always on.
- Resize (when needed) uses separable **bilinear** interpolation — good
  enough for a "basic and fast" engine. Swap in a Lanczos kernel in
  `resize_bilinear`'s call sites if you need sharper downscales.

### Customization knobs

Everything below defaults to the original engine's exact behavior, so
existing callers see no change unless they opt in:

| Flag                     | Default    | Effect                                                                 |
|--------------------------|------------|-------------------------------------------------------------------------|
| `--min-quality Q`        | `20`       | Quality floor before the autoscale fallback shrinks pixels instead.    |
| `--max-scale-tries N`    | `5`        | Shrink-and-retry rounds the autoscale fallback gets.                   |
| `--subsampling MODE`     | `444`      | Chroma subsampling: `444`, `422`, `420`, or `411`.                     |
| `--progressive`          | off        | Emit a progressive (multi-scan) JPEG instead of baseline sequential.   |
| `--crop-anchor ANCHOR`   | `center`   | For the `--width`+`--height` cover mode: `center`, `top`, `bottom`, `left`, or `right`. |

## Layout

```
src/jpegopt.c        the whole engine — decode, resize/crop, bisection search, encode
include/jpeglib.h    libjpeg-turbo public API headers (unmodified upstream)
include/jerror.h
include/jmorecfg.h
include/jpegint.h
include/jversion.h
include/jconfig.h    libjpeg-turbo build config
include/jconfigint.h libjpeg-turbo internal build config
```

`src/jpegopt.c` has no dependencies beyond a standard C library and
libjpeg/libjpeg-turbo's public API. It compiles cleanly as:

- a **native CLI** (link against your platform's libjpeg/libjpeg-turbo), or
- a **WebAssembly module** (compile with Emscripten against a libjpeg-turbo
  built for `wasm32`), or
- an **object file dropped into an existing build system** — the CLI
  `main()` and the `jpegopt_wasm_*` entry points are both defined in the
  same file behind `#ifdef __EMSCRIPTEN__`, so it links either way without
  edits.

The `include/` headers are libjpeg-turbo's own public/internal headers,
included here so a `wasm32` cross-compile has a matching, known-good
`jconfig.h`/`jconfigint.h` pair on hand. If you're building natively against
your system's libjpeg-turbo package, you can ignore `include/` entirely and
just link against the system library (see below).

**Note on `include/jconfigint.h`:** `SIZEOF_SIZE_T` is set to `4`, correct
for `wasm32`. This matters because libjpeg-turbo's optimized Huffman
encoder (`jchuff.c`) packs output bits into a machine word sized by
`SIZEOF_SIZE_T`; a wrong value desyncs the bit-buffer partway through the
entropy-coded scan and corrupts everything after that point in the output
(image decodes fine up to some point, then renders flat grey/garbage past
it). If you regenerate this header yourself (e.g. via CMake during an
Emscripten build), just confirm it lands on `4` for `wasm32` rather than
trusting a default.

## Building

### Native, linking your system's libjpeg-turbo

The simplest integration. No bundled headers needed — your OS's
`libjpeg-turbo`/`libjpeg` dev package already ships correct ones for your
target.

```sh
# Debian/Ubuntu
sudo apt-get install libjpeg-dev

cc -O2 -Wall -o jpegopt src/jpegopt.c -ljpeg -lm
```

A `Makefile` is included for convenience (`make`, `make clean`).

Usage:

```sh
./jpegopt -i in.jpg -o out.jpg -t 150 --fixed-dimension
./jpegopt -i in.jpg -o out.jpg -t 150 --width 1200
./jpegopt -i in.jpg -o out.jpg -t 150 --width 1200 --height 800
./jpegopt -i in.jpg -o out.jpg -t 150 --width 1200 --height 800 --crop-anchor top
./jpegopt -i in.jpg -o out.jpg -t 80  --subsampling 420 --progressive
./jpegopt -i in.jpg -o out.jpg -t 20  --min-quality 5 --max-scale-tries 8
```

```
-i in.jpg           input JPEG
-o out.jpg          output path
-t target_kb        target size in KB
--width W           see dimension table above
--height H
--fixed-dimension
--min-quality Q          default 20
--max-scale-tries N      default 5
--subsampling MODE       444 (default) | 422 | 420 | 411
--progressive            off by default
--crop-anchor ANCHOR     center (default) | top | bottom | left | right
```

Prints a one-line summary to stderr:

```
wrote out.jpg: 850x1276 px, q=88, 147891 bytes (target 150 KB), met target, 71.2 ms
```

### WebAssembly / other cross-compiled targets

Build your own libjpeg-turbo for the target rather than reusing anyone
else's prebuilt static library — cross-compiled libjpeg builds are
target-specific and easy to get subtly wrong (see the `SIZEOF_SIZE_T` note
above), so treat this step as part of your own build pipeline, not a
one-time artifact to copy around.

Example, targeting `wasm32` with Emscripten:

```sh
git clone --depth 1 --branch 2.1.5.1 https://github.com/libjpeg-turbo/libjpeg-turbo.git
cd libjpeg-turbo && mkdir build-wasm && cd build-wasm
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
                  -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF
emmake make -j4 jpeg-static
```

Confirm the freshly generated `jconfigint.h` has `SIZEOF_SIZE_T` set to `4`
before linking against it (CMake computes this from the actual target and
should get it right, but it's a 5-second check given exactly this value is
what caused corrupted output before).

libjpeg-turbo 2.x/3.x also has an upstream gap where its word-size
detection in `jchuff.c` doesn't recognize `wasm32`, causing a hard compile
error (`Cannot determine word size` / `undeclared identifier
'BIT_BUF_SIZE'`) rather than a silent miscompile. If you hit that, look for
`__wasm32__` handling in `jchuff.c` and add it.

Then compile the engine against it:

```sh
emcc src/jpegopt.c path/to/libjpeg.a -O3 \
  -sMODULARIZE=1 -sEXPORT_NAME=JpegOptModule \
  -sEXPORTED_FUNCTIONS=_jpegopt_wasm_run,_jpegopt_wasm_last_len,_jpegopt_wasm_last_quality,_jpegopt_wasm_last_width,_jpegopt_wasm_last_height,_jpegopt_wasm_last_met_target,_jpegopt_wasm_alloc,_jpegopt_wasm_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,HEAPU8 \
  -sALLOW_MEMORY_GROWTH=1 \
  -o jpegopt.js
```

**Verify before trusting the output**: encode a large, detailed image (a
few megapixels, not a flat test pattern — flat images won't exercise enough
Huffman-coded data to trigger a word-size bug) through both a native build
and the cross-compiled one, and confirm both outputs decode fully with no
grey/garbage regions. Test at a few different target sizes, since the
corruption point in a broken build scales with how much entropy data gets
encoded before the desync.

### Engine API (for embedding in your own JS/host runtime)

```
jpegopt_wasm_alloc(n)              -> malloc n bytes in wasm memory, returns pointer
jpegopt_wasm_free(ptr)             -> free it
jpegopt_wasm_run(inPtr, inLen, targetKb, width, height, fixedDim) -> outPtr (0 on failure)
jpegopt_wasm_run_ex(inPtr, inLen, targetKb, width, height, fixedDim,
                     minQuality, maxScaleTries, subsample, progressive,
                     cropAnchor)                                   -> outPtr (0 on failure)
jpegopt_wasm_last_len()            -> byte length of the last result
jpegopt_wasm_last_quality()        -> JPEG quality (1-100) used
jpegopt_wasm_last_width()          -> output width in px
jpegopt_wasm_last_height()         -> output height in px
jpegopt_wasm_last_met_target()     -> 1 if under budget, 0 if it had to floor out
```

`jpegopt_wasm_run` is the original 6-argument entry point, kept as a thin
wrapper over `jpegopt_wasm_run_ex` with every new knob left at its default
(`minQuality=0`→20, `maxScaleTries=0`→5, `subsample=0`→444,
`progressive=0`, `cropAnchor=0`→center) — existing callers don't need to
change anything. New integrations should call `_ex` directly.

`subsample` is an int enum: `0`=4:4:4, `1`=4:2:2, `2`=4:2:0, `3`=4:1:1.
`cropAnchor`: `0`=center, `1`=top, `2`=bottom, `3`=left, `4`=right.

Typical call sequence from a host JS runtime:

```js
const inPtr  = Module._jpegopt_wasm_alloc(buf.length);
Module.HEAPU8.set(buf, inPtr);
const outPtr = Module._jpegopt_wasm_run_ex(
  inPtr, buf.length, targetKb, width, height, fixedDim,
  minQuality, maxScaleTries, subsample, progressive, cropAnchor,
);
Module._jpegopt_wasm_free(inPtr);
if (!outPtr) { /* corrupt input */ }
const len = Module._jpegopt_wasm_last_len();
const outBytes = Module.HEAPU8.slice(outPtr, outPtr + len); // copy out before next call
```

`jpegopt_wasm_run`/`_ex` reuse one internal result buffer across calls
(freed and reallocated each time), so copy `outBytes` out via `.slice()`
(not `.subarray()`) before calling either again. Also re-read
`Module.HEAPU8` fresh after each call rather than caching it — if
`ALLOW_MEMORY_GROWTH` triggers a heap grow during that call, any
previously-captured typed-array view over the old buffer is detached.
imaging's own `jpegopt-engine.ts` wrapper handles both of these for
you; see it for a documented, TypeScript-typed reference implementation
of this exact call sequence.

## Known simplifications vs. a "full" optimizer

Deliberate, in the interest of "basic and fast" over squeezing out every
byte. (Chroma subsampling, progressive encoding, the quality floor, the
autoscale-retry budget, and crop anchoring used to be on this list too —
they're now runtime options, see "Customization knobs" above. What
remains below is still true.)

- **No perceptual metric.** Quality is picked purely to maximize JPEG
  quality under the byte budget — no MS-SSIM/GMSD pass. For a fixed image
  this is effectively equivalent in outcome (higher quality number implies
  better MS-SSIM too); it's just not independently verified per candidate.
- **Bilinear resize**, not a gamma-correct Lanczos3 — noticeably softer on
  aggressive downscales.
- **No content-analysis/guardrail stages** (edge density, grain, noise
  estimation) to pick a smart starting scale/quality — not needed since
  the bisection is already cheap enough to just run at full/requested
  resolution directly.
