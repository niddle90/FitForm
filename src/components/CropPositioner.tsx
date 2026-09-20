import { useCallback, useRef, type PointerEvent } from 'react';
import type { CropOffset } from '../engine/types';

interface Props {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  /** Fractions 0..1 on each axis. Defaults to center (0.5, 0.5) when unset. */
  offset?: CropOffset;
  onChange: (offset: CropOffset) => void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The crop box, expressed as a fraction of the *displayed* image on each
 * axis. This mirrors coverCropOrigin's math in worker.ts exactly: scale
 * the source up just enough to cover the target box, then the crop
 * window is `target / scaled` of that cover — 1.0 (no slack, no drag) on
 * whichever axis was the tight fit, less than 1.0 (draggable) on the
 * other. Because it's a fraction of the *displayed* size, this holds
 * regardless of how large the on-screen preview actually renders.
 */
function boxFraction(sourceW: number, sourceH: number, targetW: number, targetH: number) {
  if (!sourceW || !sourceH || !targetW || !targetH) return { w: 1, h: 1 };
  const scale = Math.max(targetW / sourceW, targetH / sourceH);
  return {
    w: clamp01(targetW / (sourceW * scale)),
    h: clamp01(targetH / (sourceH * scale)),
  };
}

export function CropPositioner({ sourceUrl, sourceWidth, sourceHeight, targetWidth, targetHeight, offset, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startOffset: CropOffset; travelX: number; travelY: number } | null>(
    null,
  );

  const current = offset ?? { x: 0.5, y: 0.5 };
  const { w: boxW, h: boxH } = boxFraction(sourceWidth, sourceHeight, targetWidth, targetHeight);
  const canDragX = boxW < 0.999;
  const canDragY = boxH < 0.999;

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!canDragX && !canDragY) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startOffset: current,
        travelX: rect.width * (1 - boxW),
        travelY: rect.height * (1 - boxH),
      };
    },
    [canDragX, canDragY, current, boxW, boxH],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const nx = drag.travelX > 0 ? clamp01(drag.startOffset.x + dx / drag.travelX) : drag.startOffset.x;
      const ny = drag.travelY > 0 ? clamp01(drag.startOffset.y + dy / drag.travelY) : drag.startOffset.y;
      onChange({ x: nx, y: ny });
    },
    [onChange],
  );

  const handlePointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }, []);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const STEP = 0.03;
      onChange({
        x: clamp01(current.x + (canDragX ? dx * STEP : 0)),
        y: clamp01(current.y + (canDragY ? dy * STEP : 0)),
      });
    },
    [canDragX, canDragY, current, onChange],
  );

  return (
    <div className="crop-positioner">
      <div className="crop-positioner__frame" ref={wrapRef}>
        <img src={sourceUrl} alt="" className="crop-positioner__img" draggable={false} />
        <div
          className={`crop-positioner__box ${canDragX || canDragY ? 'is-draggable' : ''}`}
          style={{
            left: `${current.x * (1 - boxW) * 100}%`,
            top: `${current.y * (1 - boxH) * 100}%`,
            width: `${boxW * 100}%`,
            height: `${boxH * 100}%`,
          }}
          role="slider"
          tabIndex={0}
          aria-label="Crop position"
          aria-valuetext={`x ${(current.x * 100).toFixed(0)}%, y ${(current.y * 100).toFixed(0)}%`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-1, 0); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(1, 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, 1); }
          }}
        >
          <div className="crop-positioner__handle" aria-hidden="true">
            ⤧
          </div>
        </div>
      </div>
      <p className="crop-positioner__hint">
        {canDragX || canDragY
          ? 'Drag the box to choose what stays in frame.'
          : `The crop already fills the full ${!canDragX ? 'width' : 'height'}. Nothing to reposition on that axis.`}
      </p>
    </div>
  );
}
