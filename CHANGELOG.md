# fitform — work log

This log covers everything done across this project, in order. Verified
means: typechecked (`tsc -b`), built (`vite build`), and for UI changes,
exercised in a real headless-Chromium session (not just read).

---

## 1. Dev-server crash fix ("engine worker crashed")

**Root cause:** `vite.config.ts` excluded `vault-suite` from
`optimizeDeps`, so in `npm run dev` it was never pre-bundled by esbuild.
It got served to the browser as a raw file, and one of its dependencies
(`wasm/jpegopt.js`, Emscripten's CommonJS glue) has no ES `export`
statement — a real browser's ESM loader can't link that, so the worker's
module graph failed before any app code ran. `vite build` didn't hit this
because Rollup bundles the worker and CJS-interops that file correctly.

**Fix:** added `vault-suite` / `vault-suite/browser` to
`optimizeDeps.include`, forcing esbuild to do the same interop in dev.

**Verified:** confirmed "engine failed" in dev → "engine ready" after the
fix, in a real headless-Chromium session; full pipeline run (upload →
compress → download) succeeded in both dev and a production
`vite build && vite preview`.

---

## 2. Full UI/UX redesign for end users

The original UI was a technical test bench (raw stage-by-stage config:
Resize / Compress / Convert / Final, numbered pipeline steps, an
always-visible log console). Rebuilt as a goal-first consumer tool:

- **Merged Dimensions control** — one width/height field pair. One side
  filled → proportional auto-scale. Both filled → crop-to-fill, with a
  center/top/bottom/left/right anchor picker.
- **Unified "Export as" control** — replaces the separate Convert stage
  and Final-output picker with one row: JPG / PNG / WebP / BMP / TGA /
  PDF (Print layout was added, then later removed — see §4 and §6).
- **Advanced panel** — resample method, compression engine, quality
  floor, chroma subsampling, progressive JPEG, miss-tolerance, output
  quality all collapsed behind "Advanced", each only shown when actually
  relevant to the current settings.
- **Light / dark / system theme**, toggle in the header, no
  flash-of-wrong-theme on load (inline script sets `data-theme` before
  paint).
- **Responsive layout** — two-column workbench above 900px, single
  column with a full-width Run button below it. Verified at 390px
  (mobile), 820px (tablet), 1280px (desktop).
- Replaced the raw log console as the primary result view with a
  before/after preview, size delta, and a download button; the technical
  log and per-stage table moved behind a collapsed "Technical details"
  disclosure for troubleshooting.

**Bugs caught and fixed during this pass** (all via visual/headless
testing, not just reading code):
- A native `<input type=file>` was visually leaking through next to the
  "Change" button (CSS selector scoping bug).
- Two print paper-size presets could show "active" at the same time
  (inverted conditional).
- Mobile header wrapped awkwardly during the "Getting ready…" boot state
  (added a responsive wrap rule).

---

## 3. Print layout: margins, custom size (later removed — see §6)

While print layout still existed, added:
- A "Custom" size option (Width/Height toggle + cm input), since the
  engine only ever accepts one physical dimension at a time, never both.
- Left/right margin fields that only appear for the matching alignment
  (left align → left margin; right align → right margin; center → no
  horizontal margin field), each mapping directly to the engine's native
  `leftCm`/`rightCm`/`topCm` parameters. A "bottom margin" idea was
  scoped out — the engine has no native bottom-anchor concept, and it was
  confirmed not needed.

---

## 4. PDF export: allow compression; print layout removed entirely

Reported bug: the "Technical details" table showed Compress hitting
146.7 KB, then Convert to PNG re-inflating the result to 5.71 MB — the
"shrink file size" promise was silently broken.

**Root cause:** PNG/BMP/TGA are lossless. Compressing to a small JPEG
internally and then converting that to a lossless format only makes the
file bigger, never smaller — there is no way to hit a target byte size in
those formats.

**Fixes:**
- "Shrink file size" now hides itself for PNG/BMP/TGA specifically, with
  an inline explanation, and skips the pointless compress-then-reinflate
  step entirely (verified: the stage table now goes straight
  Source → Convert for those formats, no wasted Compress stage).
- PDF export was the opposite case: it was previously *also* hiding
  compression, even though PDF only ever wraps a JPEG anyway, so
  compressing first genuinely controls the final PDF's size. Changed so
  PDF **shows** "Shrink file size", with a hint explaining that the
  compressed JPEG is what gets wrapped into the PDF. Verified a
  compress → PDF run end-to-end.
- **Print layout removed entirely** per direct request — the chip, its
  settings panel, and all pipeline-mapping logic. (The underlying engine
  still supports a "print" finalize mode; the app just no longer exposes
  it.)
- "Shrink file size" simplified from three size-preset chips down to one
  toggle + one plain textbox for the target KB.

---

## 5. Code review triage and fixes

A structural code review flagged 16 issues (correctness, memory,
lifecycle). Addressed the following:

- **Target-size truncation bug** (`vault-suite/src/vxpress.ts`) — the
  "input already within target" early-exit compared
  `Math.floor(bytes/1024) >= Math.floor(target)`, which could let an
  input up to ~1 KB over budget pass through unchanged (e.g. a 500.9 KB
  file against a 500 KB target). Changed to compare exact bytes against
  `targetKb * 1024`. Note: this early-exit is distinct from the
  bisection loop's internal KB-granularity search, which intentionally
  mirrors a legacy reference tool (`xpress.c`) and was left untouched.
  Rebuilt `vault-suite`'s `dist/` output; confirmed the fix is present in
  the compiled file.
- **WASM asset URL not deployment-path-aware** — was built from
  `location.origin` directly, which breaks if the app is hosted under a
  subpath (e.g. GitHub Pages). Now built from
  `import.meta.env.BASE_URL`.
- **`inspect()` fully decoding images just to read dimensions** — for
  PNG/WebP/BMP/TGA this meant a full RGBA decode (a 6000×4000 photo is
  ~92 MB) just for two numbers. Added `src/engine/imageMeta.ts`: small
  header-only parsers for PNG (IHDR), BMP (DIB header), TGA (fixed
  header), and WebP (VP8/VP8L/VP8X chunk headers). Wired into both
  `inspect()` and the pipeline's source-stage stats (which previously
  only had dimensions for JPEG), falling back to a full decode only if a
  format/variant isn't covered.
- **Misleading PDF "All pages"** — it extracted every page's JPEG into
  memory up front, but the pipeline only ever ran on one page anyway
  (selected after the fact). Removed "All pages" entirely; the app now
  only ever extracts the one page number requested, which also directly
  addresses the mobile memory concern for large PDFs.
- **Unnecessary `.slice()` copies before Blob creation** — `new
  Blob([bytes.slice().buffer])` was copying the full buffer even though
  the Blob constructor already reads exactly a TypedArray view's own
  byteOffset/length. Added a `bytesToBlob()` helper and used it
  everywhere a preview or download blob is built.
- **Log array cap** lowered from 400 to 150 lines, to reduce React
  array-copy work during long compression runs with many log lines.
- **"Same as original" changing format** — shrinking a file always
  produces a JPG (the only format the engine can hit an exact size in),
  which could be surprising if you uploaded a PNG and picked "Same as
  original". Added a contextual hint explaining this rather than
  changing the behavior itself, since there's no other format the engine
  can target a size in.

**Deliberately not attempted** (flagged as larger, separate-scope work
rather than bundled in silently):
- Operation cancellation (no way to abort an in-flight worker job).
- Worker crash recovery/auto-restart.
- Resize's intermediate PNG re-encode before a subsequent JPEG compress
  (extra memory pressure, not a correctness bug).
- A dedicated `vxcrop()` engine operation, instead of routing "crop only"
  through the compression engine.
- Pixel-level tests for crop-anchor correctness (only dimensions are
  currently tested).
- The suggested "normalized intermediate representation" pipeline
  architecture change.

---

## Verification status

All §5 fixes have now been verified end-to-end (previously only
typechecked/build-checked — this closes that gap):

- **Target-size truncation fix**: wrote a direct regression test against
  the compiled `vault-suite` engine. Prepared a JPEG at exactly 41,915
  bytes (40.933 KB) against a 40 KB target — `Math.floor(41915/1024) =
  40 = target`, which the old code treated as "already within budget"
  and returned unchanged, 933 bytes over target. The fixed code
  correctly detected `41915 > 40*1024` and re-compressed to 40,440 bytes
  (39.492 KB), `metTarget: true`. **PASS.**
- **WASM base-URL fix**: built the app with `--base=/vx-studio-sub/`
  (simulating a subpath deploy, e.g. GitHub Pages), confirmed the
  compiled worker bundle bakes in `/vx-studio-sub/wasm/` as the asset
  base, served that build from a local static server under a matching
  `/vx-studio-sub/` path, and loaded it in headless Chromium: engine
  status reached **Ready**. **PASS.**
- **Header-only dimension parsing**: generated PNG (123×77), BMP
  (200×150), WebP (88×44), and TGA (64×222) test images with
  known-distinct dimensions and uploaded each — the app reported the
  exact correct dimensions for all four. Then ran the full pipeline
  (resize to width 30) on each format to confirm the actual decode path
  used for processing (as opposed to the new header-only inspect path)
  still works — all four produced a downloadable result. **PASS.**
- **PDF "All pages" removal**: uploaded a 3-page PDF, confirmed no
  "All pages"/"One page" mode toggle exists, extracted page 2, confirmed
  the compact "Page 2 of 3" summary row with a working "Change page"
  link replaces the old multi-thumbnail grid, ran the pipeline on the
  extracted page successfully, and confirmed "Change page" correctly
  returns to the page-number form. **PASS**, 6/6 checks.
- **"Same as original" + shrink hint**: uploaded a PNG with defaults
  (Same as original, shrink on), confirmed the explanatory hint appears,
  ran it, and confirmed the downloaded file is genuinely named `.jpg`
  (i.e. the hint accurately describes what happens). **PASS.**
- **`bytesToBlob` helper / lower log cap**: exercised implicitly by every
  run above (all preview/download blobs and all logging went through the
  changed code paths without error).

Final `tsc -b --force` and `vite build` both clean after all of the
above.

---

## 6. Two items from the "deliberately not attempted" list

Picked up two of the items explicitly flagged as separate-scope in §5
(worker crash recovery, pixel-level crop-anchor tests) rather than
leaving them unaddressed indefinitely.

### Worker crash recovery

**Bug:** if the engine worker died after boot — an uncaught exception
inside vault-suite, the browser reclaiming the tab's worker under memory
pressure, etc. — `EngineClient`'s `worker.onerror` rejected whatever call
was in flight, but nothing ever told the *app* the client itself was now
permanently dead. `engineStatus` stayed `'ready'` forever, so the header
kept showing "Ready" while every subsequent call would fail the exact
same way, silently, with no path back except a full page reload.

**Fix:**
- `EngineClient` gained an `onCrash` callback (fired once per crash,
  after every pending call is rejected — mirrors how `onerror` already
  behaved, just now surfaced to the caller) and a `restart()` method that
  tears down the dead worker, spins up a fresh one, and re-runs `init()`
  on it.
- `App.tsx` wires `onCrash` to the same `engineStatus === 'error'` path
  `init()` failure already used, and the header's status pill grows a
  "Restart" button in that state, calling the new `restart()`.

**Verified:** `tsc -b` and `vite build` both clean. A full
headless-Chromium crash/restart session (matching how earlier entries in
this log were verified) wasn't possible from this environment — no
browser binary is reachable from the container's network allowlist —
so instead the actual compiled `client.ts` (via `esbuild`, unmodified
source) was run in Node against a fake `Worker` implementing the real
`onmessage`/`onerror`/`postMessage`/`terminate` contract: confirmed an
in-flight call is rejected (not left hanging) when the worker crashes,
`onCrash` fires exactly once, `restart()` terminates the dead worker and
replaces it with a working one, and a call made after `restart()` lands
on the new worker with nothing leaking to the dead one. All four checks
**PASS**. This is real logic coverage of the state machine, but it is not
the same as clicking "Restart" in an actual browser tab — that step is
still worth doing before shipping.

### Pixel-level crop-anchor tests

**Gap:** the smoke test's only crop-anchor coverage
(`croppedCompress`) checked output *dimensions* — it would have passed
even if every anchor cropped from the same spot, since it never looked
at which pixels actually survived.

**Fix:** added a real geometry test to `scripts/smoke-test.mjs`, built
around the exact scenario the original review suggested (flat-colored
halves, sampled after a real crop): a 200×100 image split green-left /
yellow-right, and a 100×200 image split red-top / blue-bottom, each
cover-cropped to 50×50 through the real WASM `vxpress` path (`engine:
'wasm'`, high `minQuality`, effectively unbounded `targetKb` so the size
bisection can't interfere with the geometry check), decoded back with
`codecs.jpeg.decode`, and sampled at both edges of the result.

**Verified:** ran against the actual compiled WASM crop core (not a
mock) — `left`/`right`/`top`/`bottom` anchors each keep their named edge
pure across the whole crop, and `center` straddles the color boundary as
expected (green→yellow left-to-right, red→blue top-to-bottom). All 6
new assertions **PASS**, alongside the full existing suite (24 checks
total, unchanged elsewhere). `npm run build` clean.

---

## 7. Operation cancellation

**Gap:** flagged as P0 in the original review — once a run started,
there was no way to stop it. Starting a large compression, then picking
a different image or changing settings, left the old worker chewing
through a bisection search or a PDF render in the background with no way
for the UI to reach it; the *displayed* run would eventually finish and
overwrite whatever the person had moved on to, or just waste battery/CPU
for a result nobody wanted.

**Why not real cooperative cancellation:** vault-suite's WASM calls
(`vxpress`'s bisection loop, `vxpeel`'s PDF rendering) run synchronously
to completion inside the worker's one JS thread once started — there's
no yield point to check a "cancelled" flag at. The review's own
mobile-friendly fallback for exactly this — "one `EngineClient` per
operation, terminate the worker when the operation is abandoned" — is
what got implemented, just applied per-call via the restart machinery
from §6 instead of asking every call site to juggle multiple client
instances.

**Fix:**
- `EngineClient.cancel()`: a no-op if nothing is pending; otherwise
  rejects the in-flight call (and anything queued behind it) with a
  `CANCELLED`-coded `EngineError`, terminates the worker outright, and
  boots + re-initializes a fresh one — reusing `restart()`, now
  parameterized with the rejection message/code so a crash and a
  cancellation are distinguishable to the caller.
- `App.tsx`: a Cancel button now sits next to Run while a job is in
  progress. `handleRun`'s catch block special-cases `code === 'CANCELLED'`
  to clear the in-progress UI quietly (a log line, no red error banner)
  rather than routing it through the same path as a genuine failure.
- No worker-side changes — `worker.ts` doesn't know or care that it got
  killed mid-job; from its side this looks identical to a crash, which
  is exactly why §6's recovery path could be reused as-is here.

**Verified:** `tsc -b` and `vite build` both clean; `npm run smoke-test`
unaffected (24/24, this doesn't touch the engine). Same limitation as
§6 — no headless-Chromium binary reachable from this environment — so
the compiled `client.ts` was run in Node (via `esbuild`, unmodified
source) against a fake `Worker` that deliberately never resolves a
`'run'` message, simulating a long operation genuinely still in flight:
confirmed `cancel()` is a no-op with nothing pending, rejects a stuck
call with `code: 'CANCELLED'` and terminates that worker, and that the
client is immediately usable again afterward — a call made right after
`cancel()` resolves lands on and completes against the fresh worker. All
4 checks **PASS**. The actual browser UI path (clicking Cancel mid-run,
confirming the worker's compute genuinely stops rather than just being
ignored) still wants a real browser session before shipping.

---

## 8. Two more items from the "deliberately not attempted" list

Picked up the resize memory-pressure item from §5's list, plus a
related React-render item from the original review that hadn't been
fully closed out yet.

### Resize no longer always materializes a lossless PNG

**Bug:** `Resize` unconditionally re-encoded its output as a lossless
PNG (`c.png.encode(resized)`), regardless of what ran next. When
`Compress` was enabled afterward — which only ever produces JPEG bytes,
see §5's "Same as original" note — that PNG was pure waste: a resized
6000×4000 photo re-encoded losslessly just to be decoded again a moment
later and thrown away re-encoding to JPEG. Worst case (JPEG in, PNG
intermediate, JPEG out) that's three full-size buffers alive at once on
exactly the mobile devices this app is supposed to be careful with.

**Fix:** `worker.ts`'s resize stage now checks whether `Compress` is
enabled next. If so, it encodes the resized pixels straight to JPEG
(q95) instead of PNG — one extra lossy generation that's negligible next
to a bisection search about to target a much smaller size anyway, in
exchange for skipping the lossless intermediate entirely. If `Compress`
is off (e.g. resize feeding into `Convert` to PNG/WebP, or resize as the
final step), the lossless PNG intermediate is kept exactly as before, so
no quality is pre-baked away for a case that actually wants it.

**Verified:** `tsc -b` and `vite build` both clean. `npm run
smoke-test` unaffected (24/24 — the smoke test exercises `vxpress`
directly and doesn't go through this app-level resize→compress
sequencing, so this needed separate checking): traced the new branch
logic by hand against both configs (resize+compress vs. resize alone /
resize+convert) and confirmed it selects JPEG only in the former case.
Real memory-pressure numbers on an actual Android device, and a real
browser run of the resize+compress path, are still worth capturing
before shipping, per the review's original mobile concern — same
browser-session caveat as §6/§7.

### Log updates batched per animation frame

**Gap:** §5 lowered the log array's cap from 400 to 150 lines but didn't
address the other half of the original review comment — "batch
messages... rather than triggering React state updates for every
individual message." A long WASM bisection search or PDF render can
still emit many log lines within a few milliseconds, and each one was
still its own `setLog` call, i.e. its own React re-render.

**Fix:** `App.tsx`'s `pushLog` now pushes onto a plain ref-held queue
and schedules at most one `requestAnimationFrame` flush; the flush
drains the whole queue into a single `setLog` call (still capped at
150). However many log lines arrive in one frame, React re-renders once
for them, not once each. The pending animation frame is cancelled on
unmount so it can't fire after the component's gone.

**Verified:** `tsc -b` and `vite build` both clean. Traced the
queue/flush logic by hand: N synchronous `pushLog` calls before a frame
fires enqueue N lines and schedule exactly one `requestAnimationFrame`
(subsequent calls before the flush runs see `logFlushHandleRef` already
set and don't schedule a second one); the flush drains the whole queue
into one `setLog`, in order, still respecting the 150-line cap. The
actual on-screen smoothness during a real long-running compress in a
browser tab is still worth a manual look before shipping, same caveat as
§6/§7's browser-only checks.

**Still not attempted** (unchanged from §5, still real future work):
- A dedicated `vxcrop()` engine operation, instead of routing "crop
  only" through the compression engine. This needs a change inside
  `vault-suite`'s WASM core (or at least a new jpegopt-engine.ts entry
  point that skips the quality bisection entirely), which is a bigger,
  separate-scope change than the app-level fixes in this entry.
- The suggested "normalized intermediate representation" pipeline
  architecture change.

---

## 9. A dedicated crop stage, decoupled from Compress

Picked up the last remaining app-scoped item from §5/§8's
"deliberately not attempted" lists: crop was still implemented by
routing through the WASM compress engine with a deliberately huge
target size, which the original review flagged as surprising —
"the user asked for crop, and the engine does crop + JPEG re-encode."

**Why this was worth doing at the app layer instead of waiting on a
`vxcrop()` engine primitive:** the WASM compress engine only ever
speaks JPEG in and out, so routing crop through it meant a PNG, WebP,
BMP, or TGA source silently came back as a JPEG even when the person
never asked to change format or reduce size — the more severe half of
the original complaint, worse than the JPEG-in case the review's
example focused on. Fixing that doesn't need a new native WASM
operation; it needs the crop to happen against decoded pixels directly
and get re-encoded in whatever format it already was, using codecs the
app already has.

**Fix:**
- New `Crop` pipeline stage (`src/engine/worker.ts`) — decodes the
  current bytes, cover-crops to the requested width/height at the
  chosen anchor (scale-to-cover via the existing resize codec, then a
  plain pixel slice — no WASM compress engine involved), and
  re-encodes in the *same format the input already was*: JPEG, PNG, and
  WebP through the existing jSquash codecs, BMP/TGA through
  `vault-suite`'s own `encodeBmp`/`encodeTga` (see below).
- `PipelineConfig` gained a `crop` step, independent of `compress`.
  `buildPipelineConfig()` (`src/state/pipeline.ts`) now always routes
  "both dimensions filled" through the new Crop stage; Compress goes
  back to being purely about "reduce file size" and no longer needs to
  know about dimensions, a crop anchor, or the `cropOnly`
  minQuality/allowMiss workaround that used to paper over using it as
  a crop tool. When both crop and "reduce file size" are on, Crop now
  runs first (exact dimensions, original format) and Compress runs
  after it, same as Resize→Compress already worked.
- `vault-suite`'s public API (`engine/vault-suite/src/index.ts`) now
  also exports `encodeBmp`/`decodeBmp`/`encodeTga`/`decodeTga` — these
  already existed as `vxconv`'s internal encoders, just not exposed, so
  a caller holding already-decoded pixels (like the new Crop stage) can
  encode straight to BMP/TGA instead of going through a bytes-in/
  bytes-out `vxconv` round trip. Pure TypeScript, no WASM/native
  changes — rebuilt `vault-suite`'s `dist/` and confirmed the export is
  present in the compiled output.
- Added a `crop: 'Cropping…'` label to the UI's stage-status map
  (`App.tsx`) so the new stage shows the same live status the other
  stages already do.

**Not attempted, still:** a true native `vxcrop()` inside the WASM
core, and the "normalized intermediate representation" architecture
change — both still require touching `vault-suite`'s C/WASM layer
(the former) or a larger cross-cutting refactor (the latter), neither
of which this pass's scope covers.

**Verified:**
- `tsc -b` and `vite build` both clean.
- `vault-suite`'s own test suite: 39/39 passing after adding the new
  exports (unchanged elsewhere).
- `npm run smoke-test`: 24/24 passing, unaffected (it exercises
  `vault-suite` directly and doesn't go through the app's new Crop
  stage).
- The app-level crop logic itself isn't covered by either of those —
  it's new code in `worker.ts`, not `vault-suite` — so it needed its
  own check: built a standalone harness against the real Node codecs
  reproducing the exact `coverCrop`/`sliceImageData`/
  `encodeFromImageData` logic now in `worker.ts`, and confirmed: (a)
  geometry — a 200×100 green-left/yellow-right image cover-cropped to
  60×60 keeps pure green at the left edge for `anchor: 'left'` and pure
  yellow at the right edge for `anchor: 'right'`; (b) format
  preservation — a PNG source cropped to 80×80 comes back as PNG (not
  JPEG), a WebP source cropped to 50×90 comes back as WebP; (c)
  asymmetric target dimensions (40×90) produce exactly that output
  size. All 5 checks **PASS**. A real browser run (uploading a PNG,
  cropping it, confirming the download is genuinely a `.png`) still
  wants a real browser session before shipping — same caveat as
  §6/§7/§8's browser-only checks.

---

## 10. Dependency install re-verified clean; unit tests added for `buildPipelineConfig()`

Two items left open from the original review's priority list
(`code_review.md`): item 16 ("build verification currently fails
because dependencies are absent") and item 15/P1-9 ("add unit tests for
`buildPipelineConfig()`").

**Dependency install (review §16):** the original failures
(`oxlint` missing, `TS2688` on `vite/client`/`node` types,
`Cannot find package 'vault-suite'`) were exactly what the review
guessed — an extracted archive with `node_modules` absent, not a real
source problem. Ran a full `npm ci` in a clean environment: 48 packages
installed (`postinstall` staged all 9 WASM codec assets into
`public/wasm/` as expected), then `npm run build` (`tsc -b && vite
build`), `npm run lint` (`oxlint`), and `npm run smoke-test` all pass
with zero errors — `vite build` succeeds with no type errors, `oxlint`
reports 28 pre-existing style warnings and 0 errors, and the smoke test
suite (24 checks) is 24/24 green. No source changes were needed here;
this closes out §16 as "confirmed non-issue," not "fixed."

**Unit tests for pipeline semantics (review §15):** `buildPipelineConfig()`,
`isNoopConfig()`, `needsCrop()`, `hidesSizeReduction()`, and
`targetLocksFormat()` in `src/state/pipeline.ts` encode the actual
product semantics of the Simple UI (what "Same as original" + "Shrink
file size" produces, when Crop vs. Resize fires, when Convert is a
no-op, etc.) but were previously only exercised indirectly by clicking
through the UI. Added `scripts/pipeline-test.mjs`:

- Runs directly against the TypeScript source (`src/state/pipeline.ts`)
  using Node 22's built-in `--experimental-strip-types` — no build step
  or bundler needed, since the file has no runtime dependencies beyond
  type-only imports.
- Covers the exact scenario matrix the review proposed in §15 (no
  settings / width only / height only / width+height / width+height+
  compression / PNG+same+compression / JPEG+same+compression /
  PDF+compression / PNG export / WebP export / crop without compression
  / crop+compression), plus the individual pure-function table checks
  (`hidesSizeReduction`, `targetLocksFormat`, `needsCrop`) and a set of
  stage-by-stage assertions on `buildPipelineConfig()`'s output
  (resize/crop mutual exclusivity, the compress-stage interaction with
  `hidesSizeReduction`, convert/final wiring).
- Wired up as `npm run pipeline-test`; `npm test` now runs it followed
  by the existing engine-level `smoke-test`.

**Verified:** `npm run pipeline-test` — 34/34 checks passing. `npm test`
runs both suites clean. `npm run build` and `npm run lint` unaffected
(test script isn't part of the build graph).

---

## 11. Worker-lifecycle regression tests for `EngineClient`

§6 ("Worker crash recovery") and §7 ("Operation cancellation") were
each verified by hand at the time with a one-off Node harness — real
coverage in the moment, but nothing left behind that would catch a
regression in `restart()`/`cancel()`/`onCrash` later, since neither
behavior can run through the existing `smoke-test.mjs` (that suite
calls into vault-suite directly; `EngineClient`'s worker-spawning and
RPC bookkeeping is pure app code with no vault-suite involvement at
all).

**Fix:** added `scripts/client-test.mjs`, following the same approach
as §10's `pipeline-test.mjs` (Node 22 `--experimental-strip-types`
against the real TypeScript source, no build step, no mocking of
`EngineClient` itself). A `FakeWorker` class implements exactly the
surface `EngineClient` touches — `onmessage`/`onerror` properties,
`postMessage(msg)`, `terminate()` — auto-resolving each request with a
minimal valid payload on the next microtask by default, with a
one-shot override any given test can install to instead simulate a
crash (fire `onerror` directly, matching what a real dying worker
does) before its response would have landed. Installed as
`globalThis.Worker` before importing `client.ts`, so the *real*,
unmodified `EngineClient` constructor spawns a `FakeWorker` without any
change to its own source. Covers:

- the happy path (`init()` resolves normally)
- a worker-level error rejects whatever call was in flight and fires
  `onCrash` exactly once
- `restart()` spawns a genuinely new worker instance, rejects anything
  still pending on the old one first, and leaves the client usable
  again afterward
- `cancel()` is a no-op (no restart) when nothing is pending
- `cancel()` rejects the in-flight call with `code: 'CANCELLED'`,
  swaps in a fresh worker, and leaves the client usable afterward
- `dispose()` terminates the worker without reporting it as a crash
  (distinguishes a deliberate teardown from `onCrash`)

**Verified:** `npm run client-test` — 8/8 checks passing. Confirmed the
tests actually catch a regression, not just pass trivially: temporarily
commented out the `this.onCrash?.(err)` call in `client.ts`, reran the
suite (the two `onCrash`-cardinality checks failed exactly as expected,
everything else stayed green since they don't depend on that line),
then restored the source and reconfirmed 8/8. Wired into `npm run
client-test` and into `npm test` (now `pipeline-test` → `client-test` →
`smoke-test`). `npm run build` and `npm run lint` both clean and
unaffected.

---

## 12. Two P0 fixes from a fresh external review (`code_review.md`)

A second, independent review of the current source (not the README/
CHANGELOG's own claims) flagged 16 issues. The two ranked P0 — the ones
that actually corrupt output or the on-screen result — are fixed here;
the remaining P1–P3 items (crop-recompression wording, the TGA
fallback, mobile peak-memory, GitHub Pages base, and the rest) are
still open and are not addressed in this entry.

### "Same as original" + Resize + Compress off still produced PNG

**Bug:** `worker.ts`'s Resize stage unconditionally encoded its
lossless intermediate as PNG whenever Compress wasn't enabled next,
regardless of what the user actually picked as the export target. So
`photo.jpg` (or `.webp`, or `.bmp`) run through Resize with "Same as
original" and "Shrink file size" off came back as `photo.png` — a
silent format change on the one setting combination that most
explicitly promises *not* to change the format. §5's "Same as
original" note only ever covered the Compress-forces-JPG case; this
Resize-forces-PNG case was still live.

**Fix:** `worker.ts` now captures the source's original format before
Resize touches anything, and Resize's post-encode choice is now
three-way instead of two-way:
- Compress runs next → JPEG intermediate (unchanged from §8).
- Convert runs next → lossless PNG intermediate (unchanged — Convert is
  about to re-encode to the real target format anyway).
- Neither runs (i.e. "Same as original", not PDF) → **encode straight
  back into the original source format** instead of defaulting to PNG.
  For a JPEG source this does mean accepting a JPEG re-encode at q95 to
  actually preserve the format — the same trade-off Crop already makes
  (§9) — which is still far more faithful to "same format" than
  silently landing on PNG.
- PDF bind as the final step keeps the PNG intermediate exactly as
  before — vxbind wants JPEG regardless and already auto-converts
  non-JPEG input itself, so this case was never actually broken.

Updated the README's "Known limitations" bullet to describe this
three-way behavior instead of the old blanket "Resize always produces a
PNG intermediate" claim.

**Verified:** `tsc -b` and `vite build` both clean. `npm test`
(`pipeline-test` → `client-test` → `smoke-test`) unaffected — 0 of
those three suites touch `worker.ts`'s Resize/Convert/Compress
sequencing, since it's app-level orchestration logic with no
`vault-suite` call of its own to intercept, same gap the original
review's item 4 called out. Traced the new three-way branch by hand
against the exact repro from the review (`photo.jpg` / `.webp` / `.bmp`
+ Resize + "Same" + Compress off) and confirmed each now selects its
own original format instead of PNG; also traced the Compress-next and
Convert-next branches to confirm neither changed. A real browser run
confirming the downloaded file for each source format is genuinely
named `.jpg`/`.webp`/`.bmp` (not just internally re-encoded as such)
is still worth doing before shipping — this is source-code-level
verification, not a browser session, same caveat as most of §6–§11's
Resize/Crop/lifecycle work.

### Changing or clearing the file mid-run could still land a stale result

**Bug:** `handleFile()` and `handleClearFile()` in `App.tsx` reset the
UI's derived state but never called `engine.cancel()` and never
invalidated whatever run was still in flight. Repro from the review:
upload image A, click Run, while it's compressing select image B —
image A's compression finishes after the swap and `handleRun()` still
calls `setResult(resultA)`, overwriting whatever the UI had already
moved on to showing for image B. The same gap existed for
`handleChangePage()` (switching PDF page mid-run) and `handleExtract()`
(re-extracting a page mid-run) — both replace `workingBytes` out from
under an in-flight run the same way.

**Fix:** `App.tsx` now tracks a run generation number (`runIdRef`,
distinct from the existing `EngineClient`-level cancellation added in
§7). `handleRun()` captures the current generation when it starts, and
every one of its callbacks — the per-stage progress/log event, the
final `setResult`, the catch block, and the `finally` — checks that the
generation is still current before writing any state. A new
`invalidateActiveRun()` helper bumps the generation and, if a run is
actually in progress, calls the existing `engine.cancel()` (a no-op if
nothing is pending, so it's safe to call unconditionally) and clears
the in-progress UI immediately. `handleFile()`, `handleClearFile()`,
`handleChangePage()`, and `handleExtract()` all call it before touching
`workingBytes`, so:
- a result that lands after the source has changed is recognized as
  stale and never reaches `setResult`/`setStageStatus`, regardless of
  whether the cancel actually raced it in time;
- the in-flight worker is also proactively terminated (not just
  ignored), so switching images mid-run doesn't leave the old job
  burning CPU in the background — the memory/battery half of the
  original complaint, not just the correctness half.

This is deliberately a generation counter plus an opportunistic
cancel, not a guarantee that changing pipeline settings mid-run also
invalidates it — the review flagged that as a "possibly" / lower-
priority extension, and it's still open.

**Verified:** `tsc -b` and `vite build` both clean. `npm test` all
three suites unaffected (this is `App.tsx` React state logic, upstream
of both `EngineClient` and `worker.ts` — neither `client-test.mjs` nor
`smoke-test.mjs` exercises this layer). Traced the exact repro by hand:
`handleRun()` captures generation N, `handleFile()` fires before N's
`engine.run()` promise settles, `invalidateActiveRun()` bumps the
generation to N+1 and calls `cancel()`; N's promise then either rejects
with `CANCELLED` (caught and dropped by the `runIdRef.current !==
myRunId` check before it would otherwise hit the `CANCELLED`-handling
branch) or, in the narrow window where the result had already resolved
before `cancel()` landed, is caught by the `setResult` guard instead —
either way `setResult(resultA)` never fires once the generation has
moved on. A real browser session actually reproducing the click-upload-
mid-run race and confirming the UI shows image B's state (not a flash
of A's result) is still worth doing before shipping, same caveat as
this entry's other fix and most of §6–§11's lifecycle work.

**Still open from `code_review.md`, not attempted in this entry:**
crop documentation overclaiming "no incidental re-compression" (P1),
`detectFormat()`'s TGA fallback treating arbitrary files as TGA (P1),
mobile peak-memory for large crop/resize (P1), browser-integration
testing for recent lifecycle work (P1), stale README claims about PDF
"all pages" and WASM asset count (P2), the GitHub Pages base-path
default (P2), TGA/PNG header validation strictness (P2), duplicate
production WASM assets (P3), and per-operation (vs. worker-wide)
cancellation (P3).

---

## 13. Five more items from `code_review.md`: TGA false-positives, crop wording, and three stale-docs items

Continuing §12's triage. This entry picks up the remaining P1/P2 items
that are actual code or documentation fixes rather than architectural
trade-offs to accept-and-document (mobile peak-memory) or work that
needs a real browser session to attempt (the browser-integration
testing gap) — both of those are still open. Per-operation cancellation
and duplicate production WASM assets (P3) are also still open.

### `detectFormat()` called virtually every unrecognized file a TGA

**Bug:** TGA has no magic number, so `detectFormat()` fell through to
`return 'tga'` for absolutely anything that didn't match JPEG/PNG/BMP/
WebP's signatures — random bytes, a truncated download, a ZIP, a text
file. That format guess then fed `inspect()`, which would read
plausible-looking width/height numbers out of whatever those bytes
happened to contain at the offsets a TGA header uses, for arbitrary
input.

**Fix:** `detectFormat()` (in `engine/vault-suite/src/vxconv/index.ts`)
now only returns `'tga'` when the bytes also pass a new `looksLikeTga()`
structural check, scoped to exactly the one TGA variant this library's
own `decodeTga()`/`encodeTga()` support: a full 18-byte header, no color
map, image type 2 (uncompressed truecolor), non-zero width/height, and
24 or 32 bits per pixel. Anything else now returns `null` (unrecognized)
instead of a false-positive `'tga'`. `vxconv()`'s existing
`default: throw new VaultError(... 'cannot decode input image')` branch
already handled a `null` `inFormat` correctly, so no caller-side change
was needed there. The app's own header-only dimension reader
(`src/engine/imageMeta.ts`'s `parseTga()`) picked up the equivalent
check and its minimum-length requirement went from 16 to the correct 18
bytes — it's exported independently of `detectFormat()`, so it needed
its own validation rather than trusting a caller already did it.

This intentionally doesn't attempt full TGA-spec validation (RLE types,
color-mapped types, grayscale types, …): a byte sequence that doesn't
match what this app can actually decode isn't useful to identify as TGA
either way, and the narrower check is simpler to reason about. It also
doesn't eliminate false positives entirely — nothing can, without a
magic number — an 18-byte prefix of unrelated binary data can still
coincidentally pass. It goes from "everything is TGA" to "TGA requires a
plausible TGA header," which is the actual goal.

**Verified:** Traced `looksLikeTga()` by hand against a real encoder
output (colorMapType 0, imageType 2, 32bpp — always passes) and against
short/random/zero-dimension inputs (all correctly rejected) — see the
worked examples in the function's own inline reasoning. Existing
`test/run.ts` TGA round-trip assertions (`bmp -> tga`, `jpg -> tga ->
jpg`) still hold against this logic since real encoder output always
satisfies the new check. Node's `--experimental-strip-types` doesn't
resolve this package's `.js`-suffixed relative imports against `.ts`
source files directly, so this was traced by hand and with an isolated
copy of `looksLikeTga()`'s logic run under plain `node -e`, not by
importing `vxconv/index.ts` itself — running the full
`engine/vault-suite` test suite against a real `npm install` (not
available in this environment) is still worth doing before shipping.

### Crop documentation claimed "no incidental re-compression" for every format

**Bug:** Both `worker.ts`'s Crop-stage comment/log line and the README's
Crop bullet said cropping never causes incidental re-compression. True
for PNG/BMP/TGA (genuinely lossless re-encodes), false for JPEG/WebP:
`encodeFromImageData()` always calls `c.jpeg.encode`/`c.webp.encode` at
a fixed quality (95), so a JPEG or WebP crop is a same-format but still
lossy re-encode — an extra generation of compression beyond what the
source already had.

**Fix:** Reworded the Crop-stage header comment, the per-run log line
(now says explicitly when a format re-compresses at q95 vs. when it's
lossless), and the README's Crop bullet to say what's actually true:
crop never changes format, but only PNG/BMP/TGA crops are lossless —
JPEG/WebP crops are a lossy re-encode.

**Verified:** Read through the reworded comment/log/README text end to
end for consistency; the underlying encode behavior in
`encodeFromImageData()` is unchanged, only the documentation and the
one log line now describing it accurately.

### Three stale documentation claims

- **README said PDF pages could be extracted "or extract all of them."**
  The engine protocol still supports `page: null` meaning every page
  (`worker.ts` still passes it through to `vxpeel`), but the UI removed
  the "all pages" option — `App.tsx`'s `handleExtract()` only ever
  extracts the single currently-selected page. Reworded the README's
  intro line to describe what the UI actually exposes.
- **README said "seven pinned" WASM files, then "two of those nine" a
  few lines later** — an internal contradiction. `copy-wasm-assets.mjs`
  copies nine files total (seven vault-suite-documented + two extra
  resize kernels); its own top-of-file comment also still said "seven."
  Reworded both to consistently say nine, explaining the seven-plus-two
  breakdown once instead of asserting two different totals.
- **GitHub Pages base path.** `import.meta.env.BASE_URL` (already fixed
  pre-§12) makes a subpath deploy *possible*, but `vite.config.ts` had
  no way to actually set that subpath — a plain `npm run build` always
  used Vite's default `/`. Added `base: process.env.VITE_BASE_PATH ||
  '/'` to `vite.config.ts` and a new README "Deploying to GitHub Pages"
  section documenting `VITE_BASE_PATH=/repo-name/ npm run build`. There's
  no `repository`/`homepage` field in `package.json` to infer this from
  automatically, so it isn't guessed — leaving the env var unset keeps
  today's root-relative build unchanged.

**Verified:** All three are documentation/config changes with no
pipeline-logic impact; `npm test`'s three suites don't touch
`vite.config.ts` or README content, so nothing new to run there.
Confirmed `App.tsx` really has no all-pages code path (grepped for
`handleExtract`) and confirmed `copy-wasm-assets.mjs`'s `files` array
has nine entries before rewording the counts. Did not run a real
`vite build` with `VITE_BASE_PATH` set against actual output (no
`node_modules` in this environment) — worth a real build-and-inspect
pass, same caveat as most config changes in this log.

**Still open from `code_review.md`:** mobile peak-memory for large
crop/resize (P1 — architectural, documented as a known limitation
rather than fixed), browser-integration testing for recent lifecycle
work (P1 — needs an actual browser session), duplicate production WASM
assets (P3), and per-operation (vs. worker-wide) cancellation (P3).

---

## 14. Mobile peak-memory (P1) and duplicate production WASM assets (P3) — plus a real `npm install` in this environment

Unlike every previous entry in this log, this one had real tooling to
verify against: `npm install` succeeded in this environment for both
`engine/vault-suite` and the root app (previous entries' "no
`node_modules` here" caveat no longer applies to what's checked below).
That's what turned the duplicate-WASM item from a documented suspicion
into a root-caused, verified fix — see that section.

### Resize/Crop held their full-resolution decoded buffer alive across every later `await` in the stage

**Bug:** `runPipeline()`'s Resize and Crop stages each do `const decoded
= await decodeToImageData(...)`, use `decoded` once (to resize or crop
it into a new buffer), and then don't touch it again — but never stopped
referencing it. An async function's local variables stay rooted across
every `await` it suspends at until they're reassigned or the function
returns: V8 compiles a suspended async function's scope into a captured
continuation, and a local that the code below never reads again doesn't
stop being "referenced" just because of that. Both stages have at least
one more `await` after `decoded`'s last real use (the re-encode call),
so `decoded`'s full-resolution pixel buffer — tens of MB for a large
photo, exactly the mobile memory-pressure case `code_review.md` flagged
— sat on the heap doing nothing for the rest of the stage (worse, for
the rest of the whole pipeline run, if a stage after Resize/Crop also
`await`s, which Compress/Convert/Finalize all do).

**Fix:** Both stages now hold `decoded` in a `let decoded: ImageData |
null`, and set it to `null` explicitly as soon as its last real read
happens — right after `c.resize.resize()`/`coverCrop()` returns, before
any further `await`. This doesn't change what either stage computes,
only how long a since-dead buffer stays reachable while later `await`s
in the same run are in flight. `coverCrop()`'s own internal `source`
variable didn't need the same treatment: everything after its one
`await` (the optional cover-scale resize) is synchronous
(`coverCropOrigin`, `sliceImageData`), so there's no further suspension
point for a stale reference to survive across.

**Verified:** `tsc -b` and `vite build` both clean (see below — this
entry is also where a real install/build first became possible in this
environment). `npm test`'s three suites (`pipeline-test`, `client-test`,
`smoke-test` — 60-ish assertions total) all still pass; none of them
exercise `runPipeline()`'s app-level orchestration directly (per
`smoke-test.mjs`'s own header comment, it mirrors vault-suite's call
shapes, not `worker.ts`'s sequencing), so this was also traced by hand:
confirmed `decoded` is narrowed non-null by TypeScript at every read
site before the `= null` line (no intervening reassignment or `await`
that would invalidate that narrowing), and confirmed via `coverCrop()`'s
source that `sliceImageData()` always allocates a fresh buffer — so
nulling `decoded` right after `coverCrop()` returns can never null out
something `cropped` still needs. Actual peak-memory numbers on a real
mobile device are still the only way to know how much this moves the
needle — same caveat as §8's original attempt at this same problem for
Resize alone.

### `vite build` was silently shipping nine WASM codec files twice, plus one nobody uses at all

**Discovery:** With a real `npm install` + `vite build` available for
the first time in this log, `dist/` was inspected directly rather than
reasoned about from source. It contained ten more `.wasm` files under
`dist/assets/*-[hash].wasm` than expected — the same nine files
`scripts/copy-wasm-assets.mjs` already copies into `dist/wasm/` (where
this app's own `fetch()` calls actually load them from), independently
re-bundled a second time under different hashed names nothing ever
requests, plus a tenth (`webp_enc_simd.wasm`) that wasn't a duplicate of
anything — just fully unused. Total `dist/` size: 13 MB before, 6.6 MB
after the fix below — roughly half of this app's production payload was
dead weight.

**Root cause:** Every `.wasm` codec this app uses is loaded explicitly,
with an already-fetched `ArrayBuffer` handed straight in —
`browser-codecs.ts`'s `jpegDecodeMod.init({ wasmBinary: jpegDecWasm
})`/`pngEncodeMod.init(pngWasm)`/etc., and `worker.ts`'s own
`initHqx(hqxBuf)`/`initMagicKernel(mkBuf)`. But every wasm-bindgen/
Emscripten-generated glue file underneath those calls
(`@jsquash/{jpeg,png,webp,resize}`'s `codec/pkg/*.js`, and
`@embedpdf/pdfium`'s browser entry) also contains its own literal,
unconditional `new URL('foo_bg.wasm', import.meta.url)` — the fallback
those libraries fall back to only if a caller *doesn't* supply a
binary. Traced by hand in each package's compiled output (e.g.
`squoosh_resize.js`'s `__wbg_init`: `if (typeof input === 'undefined')
input = new URL(...)`, and mozjpeg's Emscripten-style `n.locateFile ?
... : A = new URL(...).href` followed by a binary-sync path that
returns the pre-supplied buffer without ever calling `fetch(A)`) — we
always supply the binary, so that line never executes at runtime. But
Rollup's asset plugin doesn't know that: it statically resolves any
literal `new URL(...)` it finds against `import.meta.url` and
unconditionally emits the referenced file as a build asset, regardless
of whether the surrounding branch is ever reached. `webp_enc_simd.wasm`
is dead for an unrelated, simpler reason: `browser-codecs.ts`'s own
"NOTE on WebP SIMD" already documents that this app always selects the
baseline encoder on purpose, so nothing ever requests that build either.

**Fix:** Added a small Rollup plugin
(`stripDeadWasmBindgenDefaults()` in `vite.config.ts`, wired into
`worker.plugins` since these imports live inside the worker's own build
graph) that deletes any emitted `assets/*-[hash].wasm` file matching one
of the ten known-dead base names from the bundle in `generateBundle`,
with the full reasoning above written into its own doc comment. This
can't be fixed inside the packages themselves (pinned dependencies —
see `browser-codecs.ts`'s header on why exact versions matter here) or
by stopping Rollup from finding the reference in the first place (it's
inside each package's own compiled glue code). `jpegopt.wasm` — the one
`.wasm` file this app *does* load through a real bundler-visible
static import (`vault-suite`'s `browser-jpegopt.ts`) — correctly stays
in `dist/assets/`, untouched by the new plugin, since its base name
isn't in the dead list.

**Verified:** Real `vite build`, twice — once to capture the "before"
`dist/` listing above, once after adding the plugin to confirm all ten
dead files are gone and `dist/` shrank from 13 MB to 6.6 MB. Grepped the
rebuilt `dist/assets/*.js` for the now-deleted hashed filenames: they're
still referenced as string literals inside each package's dead
`locateFile`/`__wbg_init` fallback branch (confirming Rollup really did
rewrite those `new URL(...)` literals into the hashed paths at build
time, same as always — the plugin doesn't touch the JS, only the
now-orphaned asset files) — and by hand-tracing each one, confirmed the
branch that would actually `fetch()` that URL is gated behind exactly
the "no `wasmBinary` supplied" check this app never hits, so the
dangling reference is inert. `npm test`'s full suite (pipeline-test,
client-test, smoke-test) still passes — `smoke-test.mjs` runs against
`vault-suite/node`, not the built `dist/`, so it wasn't a build-output
check, but it does confirm every codec still initializes and produces
correct pixels from the exact `wasmBinary`-supplied call shapes this
whole fix depends on staying true. A real browser load of the built
`dist/` — confirming no request ever 404s and the app actually boots —
is still the one thing this couldn't verify directly in this
environment.

**Still open from `code_review.md`:** browser-integration testing for
recent lifecycle work (P1 — needs an actual browser session; this entry
included a real `npm install`/`vite build`/`npm test`, which narrows
what's left here specifically to "in an actual browser tab," not
"anywhere outside a text editor" the way it did before), and
per-operation (vs. worker-wide) cancellation (P3).

---

## 15. Branding pass, Vault Client ID enforced, and a stable Before/After layout

**Layout bug (Studio preview).** The Before/After grid only switched to two
columns once a result existed, so the frames changed size at every phase:
one 608px frame after upload, two stacked 608px frames while processing
(the spinner frame landed below the fold, and was 34px shorter because it
had no caption), then both collapsing to 298px when the run finished.
`PreviewResult` now renders both slots in every state (idle, running, done)
with the same aspect ratio and a fixed-height caption row, so only the
contents of the After slot change. The two-up vs. stacked choice is a
container query on the preview column (`@container preview (min-width:
30rem)`), not a viewport breakpoint, because beside the 380px controls
panel the column is only ~350px wide at a 1024px window. When stacked, the
empty After slot stays hidden until a run starts, so the original never
resizes. The post-run `scrollIntoView` also changed from `center` to
`nearest`, so it no longer scrolls when Download is already visible.

**Vault always uses the hardcoded Client ID.** `DRIVE_CLIENT_ID` now lives
in `src/drive/auth.ts` and is the only ID `createTokenClient` is ever given.
Removed: the Settings gear and panel, the Client ID input, the setup-guide
dialog, the `no-client-id` status, and `setClientId`. A value saved under
`fitform:drive-client-id` by an earlier build is deleted on load
(`purgeLegacyClientIdOverride`) and never read.

**Branding.**
- Wordmark set in Boogaloo (`--font-brand` / `font-brand`) in the sidebar,
  mobile header, Terms, and Privacy. Self-hosted via `@fontsource/boogaloo`
  instead of a Google Fonts `@import`, so the Privacy page's "Google is the
  only third party, and only when you use Vault" statement stays true.
- Static Terms/Privacy pages now load Inter and Fredoka from
  `public/fonts/` (they named Inter but never loaded it), and their logo is
  a circle like the app's rather than a rounded square.
- Logo `src` in the app resolves against `import.meta.env.BASE_URL`, so it
  loads under a subpath deploy.
- `index.html`: `theme-color` matched to the light and dark backgrounds
  (was near-black), `og:image` is now an absolute URL, and `og:site_name`
  was added.

**Page titles simplified.** `FitForm` (Studio), `Vault | FitForm` (Vault),
`Terms | FitForm`, `Privacy | FitForm`; the Terms/Privacy headings are now
"Terms" and "Privacy"; the Vault page's footer links read "Terms" and
"Privacy". The meta description is one sentence.

**Privacy page corrected.** Its "Last updated" date is September 22, 2026,
and its `localStorage` sentence now says only the cached Vault folder ID is
stored (it previously also listed theme, which isn't persisted, and the
Client ID, which no longer is).

**Verified:** `tsc -b` and `vite build` clean; `oxlint` reports the same 34
warnings as before and no errors; `pipeline-test` and `client-test` pass.
In headless Chromium, frame size was identical across idle/running/done at
1280px, 1024px, and 390px wide; a planted stale Client ID override was
deleted and Google Identity Services still received the hardcoded ID;
Boogaloo loaded on the app and both static pages with no request to
`fonts.googleapis.com`.

**Not fixed (pre-existing):** `scripts/smoke-test.mjs` still imports the
old package name `vault-suite` and the old export names (`vxpress`,
`vxprint`, `vxconv`, `vxpeel`, `vxbind`), so `npm run smoke-test` fails
with `ERR_MODULE_NOT_FOUND`. The equivalents in `imaging` are `compress`,
`printLayout`, `convertFormat`, `pdfToImages`, and `jpegsToPdf`. Confirmed
by running a temporary copy of the script with just those five names (and
the package name) swapped: every check passed. The repo's script itself was
left unchanged.

---

## 16. Vault tab, Terms/Privacy pages, and legal-link references

**Vault tab.** Signed-out visitors now get a sign-in card explaining what the
Vault is and what it can and cannot see, with the Terms/Privacy consent line
under the button. Signed-in, a header bar shows the folder name, file count
and total size with Refresh and Disconnect. File rows use per-type icons and
larger thumbnails, a labelled "Open in Studio" button, and on phones the
actions sit on their own row so long filenames aren't squeezed. Added loading
skeletons, a quieter empty state, styled upload progress/errors, and a keyboard-
operable upload box. No Drive, rename, delete or preview logic changed.

**Terms and Privacy.** Both pages now share `public/legal.css` (previously
~100 lines of duplicated inline CSS each) and `public/legal.js` (contents
highlighting only; pages work without it). Sticky top bar with Terms/Privacy
switcher, numbered sections via CSS counters, a contents list (side rail on
desktop, disclosure on phones), a responsive data table that stacks on phones,
dark mode, print styles, and prev/next navigation. Legal wording is unchanged;
only section numbers moved into CSS and the page titles became "Terms of
Service" / "Privacy Policy".

**References.** The legal pages linked to `/terms.html`, `/privacy.html` and
`/`, which 404 when deployed under `/FitForm/` (as `npm run deploy` does).
They are now relative. A shared `LegalLinks` component is used in the Vault
footer and the sidebar/mobile menu; the sign-in consent line links to the same
URLs. Links open in a new tab so the in-memory Google token isn't lost.

**Verified:** `tsc -b` clean; the changed components lint clean; Vault
rendered in headless Chromium (mocked Drive) in signed-out, signed-in, empty,
loading, uploading, dark and phone-width states; both legal pages rendered at
desktop and phone widths in light and dark, including contents highlighting.
**Not tested:** the live Google sign-in flow.
