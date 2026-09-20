import { useEffect, useRef } from 'react';

export interface LogLine {
  stage: string;
  message: string;
}

interface Props {
  lines: LogLine[];
  live: boolean;
}

export function LogConsole({ lines, live }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div className="console" ref={ref}>
      {lines.length === 0 && <div className="console__empty">waiting for engine activity…</div>}
      {lines.map((l, i) => (
        <div className="console__line" key={i}>
          <span className={`console__stage console__stage--${l.stage}`}>{l.stage}</span>
          <span>{l.message}</span>
        </div>
      ))}
      {live && <span className="console__cursor" />}
    </div>
  );
}
