import { useLayoutEffect, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Info } from 'lucide-react';

interface Props {
  children: ReactNode;
  label?: string;
}

const VIEWPORT_MARGIN = 12;
const POPOVER_WIDTH = 256;
const GAP = 8;

/** A small "i" button that reveals extra detail on demand, so the main copy next to it can stay short. */
export function InfoTip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position the popover with a fixed, viewport-clamped placement so it can
  // never spill off the left/right/top edge of the screen, no matter where
  // the trigger sits (sidebar, card edge, mobile width, etc).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);

      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));

      const spaceAbove = rect.top;
      const openUpward = spaceAbove > 160;
      const top = openUpward ? rect.top - GAP : rect.bottom + GAP;

      setStyle({
        position: 'fixed',
        left,
        width,
        top: openUpward ? undefined : top,
        bottom: openUpward ? window.innerHeight - top : undefined,
      });
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <span className="info-tip" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="info-tip__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Info size={12} />
      </button>
      {open && (
        <span role="tooltip" className="info-tip__popover" style={style}>
          {children}
        </span>
      )}
    </span>
  );
}
