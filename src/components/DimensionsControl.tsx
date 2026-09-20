import { useState } from 'react';
import { Crop, RotateCcw } from 'lucide-react';
import type { CropAnchor, CropOffset, CropRect, CropMode } from '../engine/types';
import { CropPositioner } from './CropPositioner';
import { CropSelector } from './CropSelector';

interface Props {
  width?: number;
  height?: number;
  cropAnchor: CropAnchor;
  cropMode: CropMode;
  cropOffset?: CropOffset;
  cropRect?: CropRect;
  sourceUrl?: string | null;
  sourceWidth?: number;
  sourceHeight?: number;
  onChange: (patch: {
    width?: number;
    height?: number;
    cropAnchor?: CropAnchor;
    cropMode?: CropMode;
    cropOffset?: CropOffset;
    cropRect?: CropRect;
  }) => void;
}

const ANCHORS: { value: CropAnchor; label: string }[] = [
  { value: 'center', label: 'Center' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

const FREE_CROP_SEED: CropRect = { x: 0.15, y: 0.15, w: 0.7, h: 0.7 };

/** Same cover-crop math as coverCropOrigin in worker.ts, expressed as a CropRect for the CropSelector's initial box. */
function coverRect(sourceW: number, sourceH: number, targetW: number, targetH: number, offset?: CropOffset): CropRect {
  const scale = Math.max(targetW / sourceW, targetH / sourceH);
  const scaledW = sourceW * scale;
  const scaledH = sourceH * scale;
  const w = Math.min(1, targetW / scaledW);
  const h = Math.min(1, targetH / scaledH);
  const o = offset ?? { x: 0.5, y: 0.5 };
  return { x: (1 - w) * o.x, y: (1 - h) * o.y, w, h };
}

export function DimensionsControl({
  width,
  height,
  cropAnchor,
  cropMode,
  cropOffset,
  cropRect,
  sourceUrl,
  sourceWidth,
  sourceHeight,
  onChange,
}: Props) {
  // Local, non-persisted: the crop tool is a "do it, then get out of the
  // way" panel, not something that should permanently occupy the rail
  // once a position has been chosen. Reopening it is one click away.
  const [positionerOpen, setPositionerOpen] = useState(false);

  const both = !!width && !!height;
  const hasPreview = !!(sourceUrl && sourceWidth && sourceHeight);
  const isFree = cropMode === 'free';
  const freeCropActive = isFree && !!cropRect;
  const previewHeight =
    !height && width && sourceWidth && sourceHeight ? Math.round((width * sourceHeight) / sourceWidth) : undefined;
  const previewWidth =
    !width && height && sourceWidth && sourceHeight ? Math.round((height * sourceWidth) / sourceHeight) : undefined;

  function selectExactMode(mode: 'cover' | 'zoom') {
    const patch: Parameters<Props['onChange']>[0] = { cropMode: mode };
    if (mode === 'zoom' && !cropRect && sourceWidth && sourceHeight && both) {
      patch.cropRect = coverRect(sourceWidth, sourceHeight, width!, height!, cropOffset);
    }
    onChange(patch);
    setPositionerOpen(false);
  }

  function startFreeCrop() {
    onChange({ cropMode: 'free', cropRect: cropRect ?? FREE_CROP_SEED });
  }

  function removeFreeCrop() {
    onChange({ cropMode: 'cover', cropRect: undefined });
  }

  const positionLabel = cropOffset && (cropOffset.x !== 0.5 || cropOffset.y !== 0.5) ? 'Custom' : 'Center';

  return (
    <div className="section">
      <div className="section__head">
        <h3>Dimensions</h3>
        <p>Leave both blank to keep the original size.</p>
      </div>

      <div className="dims-row">
        <label className="field">
          <span className="field__label">Width <em>px</em></span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            disabled={isFree}
            placeholder={sourceWidth ? String(sourceWidth) : 'auto'}
            value={width ?? ''}
            onChange={(e) => onChange({ width: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
        </label>
        <span className="dims-row__by">×</span>
        <label className="field">
          <span className="field__label">Height <em>px</em></span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            disabled={isFree}
            placeholder={sourceHeight ? String(sourceHeight) : 'auto'}
            value={height ?? ''}
            onChange={(e) => onChange({ height: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
        </label>
      </div>
      {/* A single shared line instead of per-field text: the two inputs
          above always stay the same height, so filling one in never
          shoves the other one around. */}
      {(previewWidth || previewHeight) && (
        <p className="field__derived">
          {previewWidth && `Width will scale to ≈${previewWidth}px to match.`}
          {previewHeight && `Height will scale to ≈${previewHeight}px to match.`}
        </p>
      )}

      {isFree && <p className="hint-text">Width and height are ignored while a free crop is active. The crop box sets the output size.</p>}

      {/* Exact-size crop: only shown once both sides are pinned, since */}
      {/* that's the only case where a crop is actually mandatory. */}
      {both && !isFree && (
        <div className="crop-block">
          <div className="crop-block__row">
            <div className="segmented segmented--compact" role="radiogroup" aria-label="Crop method">
              <button type="button" className={cropMode === 'cover' ? 'is-active' : ''} onClick={() => selectExactMode('cover')}>
                Auto crop
              </button>
              <button type="button" className={cropMode === 'zoom' ? 'is-active' : ''} onClick={() => selectExactMode('zoom')}>
                Custom box
              </button>
            </div>
          </div>

          {cropMode === 'cover' &&
            (hasPreview ? (
              <div className="crop-block__summary">
                <span>
                  Crop position: <strong>{positionLabel}</strong>
                </span>
                <button type="button" className="link-btn" onClick={() => setPositionerOpen((o) => !o)}>
                  {positionerOpen ? 'Done' : 'Adjust'}
                </button>
              </div>
            ) : (
              <div className="anchor-grid" role="radiogroup" aria-label="Crop anchor">
                {ANCHORS.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    className={cropAnchor === a.value ? 'is-active' : ''}
                    onClick={() => onChange({ cropAnchor: a.value, cropOffset: undefined })}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ))}

          {cropMode === 'cover' && hasPreview && positionerOpen && (
            <div className="crop-tool">
              <CropPositioner
                sourceUrl={sourceUrl!}
                sourceWidth={sourceWidth!}
                sourceHeight={sourceHeight!}
                targetWidth={width!}
                targetHeight={height!}
                offset={cropOffset}
                onChange={(offset) => onChange({ cropOffset: offset })}
              />
              {cropOffset && (cropOffset.x !== 0.5 || cropOffset.y !== 0.5) && (
                <button type="button" className="link-btn crop-tool__reset" onClick={() => onChange({ cropOffset: undefined })}>
                  <RotateCcw size={12} />
                  Reset to center
                </button>
              )}
            </div>
          )}

          {cropMode === 'zoom' && hasPreview && (
            <div className="crop-tool">
              <p className="hint-text">Drag to reposition, or resize from a corner. Aspect ratio stays locked to {width}×{height}.</p>
              <CropSelector
                sourceUrl={sourceUrl!}
                rect={cropRect ?? FREE_CROP_SEED}
                aspectRatio={width! / height!}
                onChange={(rect) => onChange({ cropRect: rect })}
              />
            </div>
          )}
        </div>
      )}

      {/* Free crop: an opt-in extra, only offered when there's no exact */}
      {/* size already forcing a crop — kept out of the way until asked for. */}
      {!both && hasPreview && (
        <div className="crop-block">
          {!freeCropActive ? (
            <button type="button" className="link-btn link-btn--icon" onClick={startFreeCrop}>
              <Crop size={13} />
              Add a free-form crop
            </button>
          ) : (
            <>
              <div className="crop-block__summary">
                <span>Free crop</span>
                <button type="button" className="link-btn" onClick={removeFreeCrop}>
                  Remove
                </button>
              </div>
              <div className="crop-tool">
                <p className="hint-text">Drag to reposition, or resize from a corner. Any shape, no fixed aspect ratio.</p>
                <CropSelector sourceUrl={sourceUrl!} rect={cropRect!} onChange={(rect) => onChange({ cropRect: rect })} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
