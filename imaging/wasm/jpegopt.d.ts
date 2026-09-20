/**
 * Hand-written declaration for the Emscripten-generated jpegopt.js glue
 * (built from native/jpegopt-fast-core/src/jpegopt.c — see
 * scripts/build-wasm.sh for the exact recipe). This is not auto-generated
 * by emcc; it's kept intentionally narrow, declaring only the surface
 * src/jpegopt-engine.ts actually calls, the same "four API calls out of a
 * much larger generated surface" approach codecs.ts already uses for
 * pdfium.
 */

export interface JpegOptWasmModule {
  HEAPU8: Uint8Array;
  cwrap<Args extends unknown[], Ret>(
    ident: string,
    returnType: 'number' | null,
    argTypes: string[],
  ): (...args: Args) => Ret;
  _jpegopt_wasm_alloc(n: number): number;
  _jpegopt_wasm_free(ptr: number): void;
}

export interface JpegOptModuleOverrides {
  /** Raw wasm bytes. Always pass this — see jpegopt-engine.ts for why. */
  wasmBinary: Uint8Array | ArrayBuffer;
}

export default function createJpegOptModule(
  overrides: JpegOptModuleOverrides,
): Promise<JpegOptWasmModule>;
