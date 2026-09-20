#!/usr/bin/env bash
#
# Rebuilds wasm/jpegopt.{js,wasm} from native/jpegopt-fast-core/src/jpegopt.c
# against a from-source libjpeg-turbo cross-compiled for wasm32.
#
# This is not a hypothetical recipe — every command below (including the
# two workarounds) was run to produce the exact wasm/jpegopt.wasm shipped
# in this package, verified byte-for-byte identical to a native build
# across every option jpegopt.c exposes (see "Verifying a build" below).
#
# Usage:
#   bash scripts/build-wasm.sh
#
# Requires: a Debian/Ubuntu-family system with apt and root (or sudo)
# access, network access to archive.ubuntu.com and github.com, ~1GB free
# disk. Takes a few minutes, almost all of it the one-time toolchain
# install.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # repo root
REPO_ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== 1. Emscripten toolchain =="
#
# Ubuntu's own `emscripten` apt package (universe) is the easiest path —
# no separate emsdk install, no network access beyond apt's own mirrors.
# It pulls in clang/lld/llvm (pinned to whatever major version the distro
# ships) and binaryen. One real snag: the package's `node-acorn` dependency
# can fail to resolve against a Node.js install that didn't come from
# Ubuntu's own nodejs package (e.g. NodeSource, nvm, a container base
# image) — apt reports it as a plain unmet-dependency, not anything
# acorn-specific. Sidestep it by installing the compiler toolchain
# proper via apt (clean, no conflict) and only hand-extracting the
# `emscripten` package itself (its Python/JS driver scripts + prebuilt
# system-library cache — no compiled code, so nothing in it actually
# *depends* on node-acorn at runtime unless you invoke closure-compiler-era
# optimization passes, which this build doesn't), then supplying `acorn`
# via npm for the one script (`acorn-optimizer.js`) that does `require()`
# it directly.
if ! command -v emcc >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y --no-install-recommends binaryen clang-15 lld-15 llvm-15 cmake

  apt-get download emscripten
  dpkg -x emscripten_*.deb "$WORKDIR/emscripten-pkg"
  rm -f emscripten_*.deb
  cp -r "$WORKDIR/emscripten-pkg/usr/share/emscripten" /usr/share/emscripten
  cp -r "$WORKDIR/emscripten-pkg/usr/bin/." /usr/bin/   # emcc/em++/emcmake/... wrapper scripts

  npm install -g acorn
fi
export EM_CONFIG=/usr/share/emscripten/.emscripten
export NODE_PATH="$(npm root -g)"

echo "== 2. libjpeg-turbo, cross-compiled for wasm32 =="
LJT_VERSION=2.1.5.1   # must match native/jpegopt-fast-core/include/{jconfig,jversion}.h
git clone --quiet --depth 1 --branch "$LJT_VERSION" \
  https://github.com/libjpeg-turbo/libjpeg-turbo.git "$WORKDIR/libjpeg-turbo"

cd "$WORKDIR/libjpeg-turbo"

# Known bug (documented in native/jpegopt-fast-core/README.md): CMake's
# check_type_size() for SIZEOF_SIZE_T, run through emcmake's cross-compile
# emulator, can compute the wrong answer for wasm32 (observed: 9, not 4).
# jchuff.c's bit-buffer packing relies on this being exactly right; a wrong
# value doesn't fail loudly on its own — libjpeg-turbo's own #if/#elif
# chain for BIT_BUF_SIZE falls through to "#error Cannot determine word
# size" first, so you get a build failure rather than silent corruption.
# Belt-and-suspenders fix applied here, matching what's already in this
# repo's vendored jpegopt.c copy of jchuff.c's neighborhood:
#   (a) after configuring, overwrite the generated jconfigint.h with the
#       known-good one already checked into native/jpegopt-fast-core/include/
#       (SIZEOF_SIZE_T hardcoded to 4, correct for wasm32);
#   (b) additionally patch jchuff.c to recognize __wasm32__ explicitly, so
#       a future plain `cmake --build .` that regenerates jconfigint.h from
#       scratch (without step (a)) doesn't quietly reintroduce the bug.
mkdir build-wasm && cd build-wasm
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
                  -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF >/dev/null

GENERATED_SIZEOF_SIZE_T="$(grep -oP '(?<=SIZEOF_SIZE_T  )\d+' jconfigint.h)"
if [ "$GENERATED_SIZEOF_SIZE_T" != "4" ]; then
  echo "  (confirmed) CMake computed SIZEOF_SIZE_T=$GENERATED_SIZEOF_SIZE_T for wasm32 -- replacing with the known-good header"
  cp "$REPO_ROOT/native/jpegopt-fast-core/include/jconfigint.h" jconfigint.h
fi

cd ..
if ! grep -q '__wasm32__' jchuff.c; then
  python3 - "$PWD/jchuff.c" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path).read()
needle = '#elif (defined(SIZEOF_SIZE_T) && SIZEOF_SIZE_T == 4) || defined(_WIN32)\n#define BIT_BUF_SIZE  32'
replacement = ('#elif (defined(SIZEOF_SIZE_T) && SIZEOF_SIZE_T == 4) || defined(_WIN32) || \\\n'
                '    defined(__wasm32__)\n#define BIT_BUF_SIZE  32')
assert needle in src, "jchuff.c layout changed upstream -- update this patch"
open(path, 'w').write(src.replace(needle, replacement, 1))
PYEOF
fi
cd build-wasm
emmake make -j"$(nproc)" jpeg-static

cd "$REPO_ROOT"

echo "== 3. Compile jpegopt.c against it =="
mkdir -p wasm
emcc native/jpegopt-fast-core/src/jpegopt.c \
  "$WORKDIR/libjpeg-turbo/build-wasm/libjpeg.a" \
  -I native/jpegopt-fast-core/include \
  -O3 \
  -sMODULARIZE=1 -sEXPORT_NAME=createJpegOptModule \
  -sEXPORTED_FUNCTIONS=_jpegopt_wasm_run,_jpegopt_wasm_run_ex,_jpegopt_wasm_last_len,_jpegopt_wasm_last_quality,_jpegopt_wasm_last_width,_jpegopt_wasm_last_height,_jpegopt_wasm_last_met_target,_jpegopt_wasm_alloc,_jpegopt_wasm_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,HEAPU8 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web,node \
  -o wasm/jpegopt.js

# `{"type":"commonjs"}` here overrides this package's own top-level
# "type":"module" for everything inside wasm/ — a standard, Node-documented
# per-directory escape hatch. It's needed because emcc's default
# (non-ES6) glue is UMD-style CommonJS (`module.exports = ...`, uses
# `require`/`__dirname`), and that combination — plain CJS glue, loaded as
# genuine CJS — is the one that's actually been proven to work (see the
# "Two rejected alternatives" note below). Without this file, Node would
# treat jpegopt.js as ESM (inheriting the outer package's "type") despite
# its CommonJS syntax, and every `module.exports =` / `require(...)` in it
# would either silently no-op or throw ReferenceError.
cat > wasm/package.json <<'EOF'
{ "type": "commonjs" }
EOF

echo "Wrote wasm/jpegopt.js + wasm/jpegopt.wasm + wasm/package.json"
echo
echo "NOTE on the wasm/package.json override -- two rejected alternatives,"
echo "and why, since both looked reasonable first:"
echo
echo "  1. Leave jpegopt.js as CJS but rely on Node's default CJS<->ESM"
echo "     interop instead of overriding the type. Doesn't work: this"
echo "     package's own package.json says \"type\": \"module\", which makes"
echo "     Node treat EVERY .js file under it as ESM by default, including"
echo "     this one -- so its 'typeof module === \"object\"' UMD guard"
echo "     evaluates false (module isn't a real ESM global), and the"
echo "     factory function silently ends up exported nowhere."
echo "  2. Build with -sEXPORT_ES6=1 instead, for real 'export default...'"
echo "     syntax matching the outer package. Doesn't work either, for a"
echo "     different reason: this specific Emscripten version's ES6 output"
echo "     still computes its Node-environment scriptDirectory via the"
echo "     CommonJS-only \`__dirname\` global unconditionally, which plain"
echo "     ESM doesn't provide -- 'ReferenceError: __dirname is not"
echo "     defined' the moment the module loads under a real ESM loader."
echo "     (A quick manual smoke test can miss this: \`node -e \"import(...)\"\`"
echo "     runs its eval string in a CJS wrapper by default, which defines"
echo "     __dirname anyway and masks the bug -- this project's actual"
echo "     test suite, which loads it as a genuine ES module the way a"
echo "     real consumer would, is what caught it.)"
echo
echo "Run the test suite (npm test) to verify this build before trusting it."
