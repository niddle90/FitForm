// Unit tests for src/state/pipeline.ts — the pure functions that translate
// the simple end-user state into the technical PipelineConfig the worker
// runs. These functions carry the app's actual product semantics (what
// "Same as original", "Shrink file size", crop, etc. mean in practice), so
// they get their own fast, dependency-free test file instead of only being
// exercised indirectly through the engine-level smoke test.
//
// Run with: node scripts/pipeline-test.mjs
// (Node 22+ strips the `import type` / type-annotation syntax in
// src/state/pipeline.ts natively — no build step needed.)

import assert from 'node:assert/strict';
import {
  buildPipelineConfig,
  defaultSimpleState,
  defaultAdvancedSettings,
  needsCrop,
  isNoopConfig,
  hidesSizeReduction,
  targetLocksFormat,
} from '../src/state/pipeline.ts';

const ok = (label) => console.log(`  ✓ ${label}`);
const section = (label) => console.log(`\n${label}`);

/** Builds a full SimpleState from a partial patch, on top of the app's own defaults. */
function state(patch) {
  return { ...defaultSimpleState(), advanced: defaultAdvancedSettings(), ...patch };
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    ok(label);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
  }
}

// ── hidesSizeReduction / targetLocksFormat: simple table checks ────────

section('hidesSizeReduction: lossless formats only');
check('png/bmp/tga hide size reduction', () => {
  assert.equal(hidesSizeReduction('png'), true);
  assert.equal(hidesSizeReduction('bmp'), true);
  assert.equal(hidesSizeReduction('tga'), true);
});
check('jpg/webp/same/pdf do not hide size reduction', () => {
  assert.equal(hidesSizeReduction('jpg'), false);
  assert.equal(hidesSizeReduction('webp'), false);
  assert.equal(hidesSizeReduction('same'), false);
  assert.equal(hidesSizeReduction('pdf'), false);
});

section('targetLocksFormat: only PDF forces its own re-encode');
check('pdf locks format, everything else does not', () => {
  assert.equal(targetLocksFormat('pdf'), true);
  for (const t of ['same', 'jpg', 'png', 'webp', 'bmp', 'tga']) {
    assert.equal(targetLocksFormat(t), false, `${t} should not lock format`);
  }
});

// ── needsCrop ────────────────────────────────────────────────────────

section('needsCrop: true only when both dimensions are pinned');
check('no dims -> false', () => assert.equal(needsCrop({}), false));
check('width only -> false', () => assert.equal(needsCrop({ width: 100 }), false));
check('height only -> false', () => assert.equal(needsCrop({ height: 100 }), false));
check('both dims -> true', () => assert.equal(needsCrop({ width: 100, height: 50 }), true));

// ── isNoopConfig ─────────────────────────────────────────────────────

section('isNoopConfig: matches the P0/P1 scenario matrix from the code review');
check('no settings at all -> noop', () => {
  assert.equal(isNoopConfig(state({ reduceSize: false })), true);
});
check('width only (proportional resize) -> not noop', () => {
  assert.equal(isNoopConfig(state({ width: 200, reduceSize: false })), false);
});
check('height only (proportional resize) -> not noop', () => {
  assert.equal(isNoopConfig(state({ height: 200, reduceSize: false })), false);
});
check('width + height (crop) -> not noop', () => {
  assert.equal(isNoopConfig(state({ width: 200, height: 200, reduceSize: false })), false);
});
check('width + height + compression -> not noop', () => {
  assert.equal(isNoopConfig(state({ width: 200, height: 200, reduceSize: true })), false);
});
check('PNG + same + compression -> not noop (reduceSize still runs, see hint-text)', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'same', reduceSize: true })), false);
});
check('JPEG + same + compression -> not noop', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'same', reduceSize: true })), false);
});
check('PDF + compression -> not noop (finalizing alone is enough)', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'pdf', reduceSize: false })), false);
});
check('PDF, reduceSize off -> still not noop (finalizing)', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'pdf', reduceSize: false })), false);
});
check('PNG export (pure reformat, no compression) -> not noop', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'png', reduceSize: false })), false);
});
check('WebP export -> not noop', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'webp', reduceSize: false })), false);
});
check('crop without compression -> not noop', () => {
  assert.equal(isNoopConfig(state({ width: 80, height: 80, reduceSize: false })), false);
});
check('crop + compression -> not noop', () => {
  assert.equal(isNoopConfig(state({ width: 80, height: 80, reduceSize: true })), false);
});
check('same + reduceSize requested but format hides it (edge case: reduceSize off) -> noop', () => {
  // "same" never hides reduction on its own — hidesSizeReduction only
  // covers png/bmp/tga — so the only way to get a true noop here is to
  // also turn reduceSize off, which is the "no settings at all" case above.
  assert.equal(isNoopConfig(state({ exportTarget: 'same', reduceSize: false })), true);
});
check('png export target + reduceSize on -> not noop (reformat runs even though reduce is hidden)', () => {
  assert.equal(isNoopConfig(state({ exportTarget: 'png', reduceSize: true })), false);
});

// ── buildPipelineConfig: the semantics that actually matter ────────────

section('buildPipelineConfig: resize stage');
check('one dimension enables proportional resize, not crop', () => {
  const cfg = buildPipelineConfig(state({ width: 300, reduceSize: false }));
  assert.equal(cfg.resize.enabled, true);
  assert.equal(cfg.crop.enabled, false);
});
check('zero dimensions disables both resize and crop', () => {
  const cfg = buildPipelineConfig(state({ reduceSize: false }));
  assert.equal(cfg.resize.enabled, false);
  assert.equal(cfg.crop.enabled, false);
});

section('buildPipelineConfig: crop stage');
check('both dimensions enable crop, not proportional resize', () => {
  const cfg = buildPipelineConfig(state({ width: 100, height: 60, reduceSize: false }));
  assert.equal(cfg.crop.enabled, true);
  assert.equal(cfg.resize.enabled, false);
  assert.equal(cfg.crop.width, 100);
  assert.equal(cfg.crop.height, 60);
});
check('crop carries the chosen anchor through untouched', () => {
  const cfg = buildPipelineConfig(state({ width: 100, height: 60, cropAnchor: 'top', reduceSize: false }));
  assert.equal(cfg.crop.anchor, 'top');
});

section('buildPipelineConfig: compress stage / hidesSizeReduction interaction');
check('reduceSize on + JPG target -> compress enabled', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'jpg', reduceSize: true }));
  assert.equal(cfg.compress.enabled, true);
});
check('reduceSize on + PNG target -> compress silently disabled (lossless can\'t hit a target size)', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'png', reduceSize: true }));
  assert.equal(cfg.compress.enabled, false);
});
check('reduceSize on + BMP/TGA target -> compress disabled', () => {
  assert.equal(buildPipelineConfig(state({ exportTarget: 'bmp', reduceSize: true })).compress.enabled, false);
  assert.equal(buildPipelineConfig(state({ exportTarget: 'tga', reduceSize: true })).compress.enabled, false);
});
check('reduceSize off -> compress disabled regardless of target', () => {
  assert.equal(buildPipelineConfig(state({ exportTarget: 'jpg', reduceSize: false })).compress.enabled, false);
});
check('reduceSize on + "same" target -> compress enabled (this is the JPEG-even-for-PNG-input case; see hint-text in App.tsx)', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'same', reduceSize: true }));
  assert.equal(cfg.compress.enabled, true);
});
check('reduceSize on + PDF target -> compress stays enabled (PDF wraps a JPEG, so shrinking still applies)', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'pdf', reduceSize: true }));
  assert.equal(cfg.compress.enabled, true);
});

section('buildPipelineConfig: convert stage / export target');
check('"same" never enables Convert', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'same', reduceSize: false }));
  assert.equal(cfg.convert.enabled, false);
});
check('an explicit image format enables Convert with that format', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'webp', reduceSize: false }));
  assert.equal(cfg.convert.enabled, true);
  assert.equal(cfg.convert.format, 'webp');
});
check('PDF target disables Convert (targetLocksFormat) even though it is not "same"', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'pdf', reduceSize: false }));
  assert.equal(cfg.convert.enabled, false);
});

section('buildPipelineConfig: final stage');
check('PDF target produces a bind final step', () => {
  const cfg = buildPipelineConfig(state({ exportTarget: 'pdf', reduceSize: false }));
  assert.deepEqual(cfg.final, { kind: 'bind' });
});
check('every non-PDF target produces no final step', () => {
  for (const t of ['same', 'jpg', 'png', 'webp', 'bmp', 'tga']) {
    const cfg = buildPipelineConfig(state({ exportTarget: t, reduceSize: false }));
    assert.deepEqual(cfg.final, { kind: 'none' }, `${t} should not finalize`);
  }
});

section('buildPipelineConfig: full scenario matrix from the code review (§15)');
const scenarios = [
  { label: 'no settings', patch: { reduceSize: false }, expect: { resize: false, crop: false, compress: false, convert: false, final: 'none' } },
  { label: 'width only', patch: { width: 200, reduceSize: false }, expect: { resize: true, crop: false, compress: false, convert: false, final: 'none' } },
  { label: 'height only', patch: { height: 200, reduceSize: false }, expect: { resize: true, crop: false, compress: false, convert: false, final: 'none' } },
  { label: 'width + height', patch: { width: 200, height: 200, reduceSize: false }, expect: { resize: false, crop: true, compress: false, convert: false, final: 'none' } },
  { label: 'width + height + compression', patch: { width: 200, height: 200, reduceSize: true }, expect: { resize: false, crop: true, compress: true, convert: false, final: 'none' } },
  { label: 'PNG + same + compression', patch: { exportTarget: 'same', reduceSize: true }, expect: { resize: false, crop: false, compress: true, convert: false, final: 'none' } },
  { label: 'JPEG + same + compression', patch: { exportTarget: 'same', reduceSize: true }, expect: { resize: false, crop: false, compress: true, convert: false, final: 'none' } },
  { label: 'PDF + compression', patch: { exportTarget: 'pdf', reduceSize: true }, expect: { resize: false, crop: false, compress: true, convert: false, final: 'bind' } },
  { label: 'PNG export', patch: { exportTarget: 'png', reduceSize: false }, expect: { resize: false, crop: false, compress: false, convert: true, final: 'none' } },
  { label: 'WebP export', patch: { exportTarget: 'webp', reduceSize: false }, expect: { resize: false, crop: false, compress: false, convert: true, final: 'none' } },
  { label: 'crop without compression', patch: { width: 80, height: 80, reduceSize: false }, expect: { resize: false, crop: true, compress: false, convert: false, final: 'none' } },
  { label: 'crop + compression', patch: { width: 80, height: 80, reduceSize: true }, expect: { resize: false, crop: true, compress: true, convert: false, final: 'none' } },
];
for (const { label, patch, expect } of scenarios) {
  check(label, () => {
    const cfg = buildPipelineConfig(state(patch));
    assert.equal(cfg.resize.enabled, expect.resize, 'resize.enabled');
    assert.equal(cfg.crop.enabled, expect.crop, 'crop.enabled');
    assert.equal(cfg.compress.enabled, expect.compress, 'compress.enabled');
    assert.equal(cfg.convert.enabled, expect.convert, 'convert.enabled');
    assert.equal(cfg.final.kind, expect.final, 'final.kind');
  });
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all pipeline-config checks passed');
