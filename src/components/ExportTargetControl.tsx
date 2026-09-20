import { FileImage, FileText } from 'lucide-react';
import { EXPORT_TARGETS, type ExportTarget } from '../state/pipeline';

interface Props {
  value: ExportTarget;
  onChange: (v: ExportTarget) => void;
}

const IMAGE_TARGETS = EXPORT_TARGETS.filter((t) => t.value !== 'pdf');

export function ExportTargetControl({ value, onChange }: Props) {
  return (
    <div className="section">
      <div className="section__head">
        <h3>Export as</h3>
        <p>What kind of file you want to end up with.</p>
      </div>

      <div className="chip-grid">
        {IMAGE_TARGETS.map((t) => (
          <button key={t.value} type="button" className={`chip${value === t.value ? ' is-active' : ''}`} onClick={() => onChange(t.value)}>
            <FileImage size={14} />
            {t.label}
          </button>
        ))}
        <button type="button" className={`chip${value === 'pdf' ? ' is-active' : ''}`} onClick={() => onChange('pdf')}>
          <FileText size={14} />
          PDF
        </button>
      </div>
    </div>
  );
}
