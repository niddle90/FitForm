import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Info } from 'lucide-react';

interface Props {
  children: ReactNode;
  label?: string;
}

/** Minimum gap to keep between the popover and the edge of the viewport. */
const EDGE_PADDING = 12;

/** A small "i" button that reveals extra detail on demand, so the main copy next to it can stay short. */
export function InfoTip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  // The popover is centered on the trigger by default, which pushes it past
  // the edge of the screen whenever the trigger sits near the left/right side
  // (e.g. on mobile, or inside a narrow sidebar). Nudge it back on-screen.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const recalc = () => {
      const el = popoverRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let next = 0;
      if (rect.left < EDGE_PADDING) {
        next = EDGE_PADDING - rect.left;
      } else if (rect.right > window.innerWidth - EDGE_PADDING) {
        next = window.innerWidth - EDGE_PADDING - rect.right;
      }
      setShift((prev) => (prev === next ? prev : next));
    };
    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [open]);

  return (
    <span className="info-tip" ref={ref}>
      <button
        type="button"
        className="info-tip__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Info size={12} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="info-tip__popover"
          ref={popoverRef}
          style={{ '--info-tip-shift': `${shift}px` } as CSSProperties}
        >
          {children}
        </span>
      )}
    </span>
  );
}
