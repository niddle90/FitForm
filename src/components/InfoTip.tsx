import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

interface Props {
  children: ReactNode;
  label?: string;
}

/** A small "i" button that reveals extra detail on demand, so the main copy next to it can stay short. */
export function InfoTip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

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
        <span role="tooltip" className="info-tip__popover">
          {children}
        </span>
      )}
    </span>
  );
}
