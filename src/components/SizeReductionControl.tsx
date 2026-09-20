import { formatBytes } from '../state/pipeline';
import { Switch } from './Switch';
import { Input } from './ui/input';

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  targetKb: number;
  onTargetKbChange: (kb: number) => void;
}

export function SizeReductionControl({ enabled, onEnabledChange, targetKb, onTargetKbChange }: Props) {
  return (
    <div className="section">
      <div className="section__head section__head--switch">
        <div>
          <h3>Shrink file size</h3>
          <p>Compress until the file is at or under a target size.</p>
        </div>
        <Switch checked={enabled} onChange={onEnabledChange} label="Shrink file size" />
      </div>

      {enabled && (
        <label className="field">
          <span className="field__label">
            Target size <em>{formatBytes(Math.max(0, targetKb) * 1024)}</em>
          </span>
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={targetKb}
            onChange={(e) => onTargetKbChange(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      )}
    </div>
  );
}
