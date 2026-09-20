import { useCallback, useRef, type PointerEvent } from 'react';
import type { CropRect } from '../engine/types';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface Props {
  sourceUrl: string;
  rect: CropRect;
  /**
   * Target width/height ratio (pixels) to lock the box to, e.g. 16/9.
   * Omit for a fully free-form box (mode 'free') — corners then resize
   * both axes independently.
   */
  aspectRatio?: number;
  onChange: (rect: CropRect) => void;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const MIN_PX = 24; // smallest box side, in on-screen pixels, so handles stay grabbable

interface MoveDrag {
  startClientX: number;
  startClientY: number;
  startRect: CropRect;
  wrapW: number;
  wrapH: number;
}
interface ResizeDrag {
  corner: Corner;
  anchorPxX: number;
  anchorPxY: number;
  wrapLeft: number;
  wrapTop: number;
  wrapW: number;
  wrapH: number;
}

export function CropSelector({ sourceUrl, rect, aspectRatio, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  const resizeRef = useRef<ResizeDrag | null>(null);

  const handleMoveDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const wrapRectPx = wrapRef.current?.getBoundingClientRect();
      if (!wrapRectPx) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      moveRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startRect: rect,
        wrapW: wrapRectPx.width,
        wrapH: wrapRectPx.height,
      };
    },
    [rect],
  );

  const handleMoveMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = moveRef.current;
      if (!drag) return;
      const dx = (e.clientX - drag.startClientX) / drag.wrapW;
      const dy = (e.clientY - drag.startClientY) / drag.wrapH;
      onChange({
        ...drag.startRect,
        x: clamp01(Math.min(1 - drag.startRect.w, Math.max(0, drag.startRect.x + dx))),
        y: clamp01(Math.min(1 - drag.startRect.h, Math.max(0, drag.startRect.y + dy))),
      });
    },
    [onChange],
  );

  const handleMoveUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (moveRef.current) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    moveRef.current = null;
  }, []);

  const handleResizeDown = useCallback(
    (corner: Corner) => (e: PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const wrapRectPx = wrapRef.current?.getBoundingClientRect();
      if (!wrapRectPx) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      // The anchor is the corner opposite the one being dragged — it stays
      // put while the dragged corner (and therefore the box's size) moves.
      const anchorFrac =
        corner === 'nw'
          ? { x: rect.x + rect.w, y: rect.y + rect.h }
          : corner === 'ne'
            ? { x: rect.x, y: rect.y + rect.h }
            : corner === 'sw'
              ? { x: rect.x + rect.w, y: rect.y }
              : { x: rect.x, y: rect.y };
      resizeRef.current = {
        corner,
        anchorPxX: anchorFrac.x * wrapRectPx.width,
        anchorPxY: anchorFrac.y * wrapRectPx.height,
        wrapLeft: wrapRectPx.left,
        wrapTop: wrapRectPx.top,
        wrapW: wrapRectPx.width,
        wrapH: wrapRectPx.height,
      };
    },
    [rect],
  );

  const handleResizeMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const drag = resizeRef.current;
      if (!drag) return;
      const { corner, anchorPxX, anchorPxY, wrapW, wrapH, wrapLeft, wrapTop } = drag;
      const curPxX = Math.min(wrapW, Math.max(0, e.clientX - wrapLeft));
      const curPxY = Math.min(wrapH, Math.max(0, e.clientY - wrapTop));

      let wPx = Math.max(MIN_PX, Math.abs(curPxX - anchorPxX));
      let hPx = Math.max(MIN_PX, Math.abs(curPxY - anchorPxY));

      // The wrapper's own pixel aspect ratio equals the source image's,
      // since the <img> fills it at its natural aspect — so a screen-pixel
      // aspect ratio here is exactly the source-pixel aspect ratio too.
      // No source width/height needed to keep this box locked to `aspectRatio`.
      const growsRight = corner === 'se' || corner === 'ne';
      const growsDown = corner === 'se' || corner === 'sw';
      const maxWFromAnchor = growsRight ? wrapW - anchorPxX : anchorPxX;
      const maxHFromAnchor = growsDown ? wrapH - anchorPxY : anchorPxY;

      if (aspectRatio) {
        const maxW = Math.min(maxWFromAnchor, maxHFromAnchor * aspectRatio);
        wPx = Math.min(Math.max(wPx, hPx * aspectRatio), maxW);
        hPx = wPx / aspectRatio;
      } else {
        wPx = Math.min(wPx, maxWFromAnchor);
        hPx = Math.min(hPx, maxHFromAnchor);
      }

      const x0 = growsRight ? anchorPxX : anchorPxX - wPx;
      const y0 = growsDown ? anchorPxY : anchorPxY - hPx;

      onChange({ x: x0 / wrapW, y: y0 / wrapH, w: wPx / wrapW, h: hPx / wrapH });
    },
    [onChange, aspectRatio],
  );

  const handleResizeUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (resizeRef.current) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  }, []);

  const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];

  return (
    <div className="crop-positioner">
      <div className="crop-positioner__frame" ref={wrapRef}>
        <img src={sourceUrl} alt="" className="crop-positioner__img" draggable={false} />
        <div
          className="crop-selector__box"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
          }}
          onPointerDown={handleMoveDown}
          onPointerMove={handleMoveMove}
          onPointerUp={handleMoveUp}
          onPointerCancel={handleMoveUp}
        >
          {corners.map((c) => (
            <div
              key={c}
              className={`crop-selector__handle crop-selector__handle--${c}`}
              onPointerDown={handleResizeDown(c)}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeUp}
              onPointerCancel={handleResizeUp}
            />
          ))}
        </div>
      </div>
      <p className="crop-positioner__hint">
        Drag inside the box to move it, or drag a corner to resize{aspectRatio ? ' (aspect ratio stays locked)' : ''}.
      </p>
    </div>
  );
}
