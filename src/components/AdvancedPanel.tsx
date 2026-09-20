import { useState } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import type { AdvancedSettings } from '../state/pipeline';
import type { ResizeMethod, CompressEngine, SubsamplingMode } from '../engine/types';
import { Slider } from './ui/slider';

interface Props {
  value: AdvancedSettings;
  onChange: (patch: Partial<AdvancedSettings>) => void;
  showResizeMethod: boolean;
  showCompressTuning: boolean;
  showConvertQuality: boolean;
}

const RESIZE_METHODS: { value: ResizeMethod; label: string }[] = [
  { value: 'lanczos3', label: 'Lanczos3 (sharp, general purpose)' },
  { value: 'catrom', label: 'Catmull-Rom (sharp, less ringing)' },
  { value: 'mitchell', label: 'Mitchell (balanced)' },
  { value: 'triangle', label: 'Triangle (soft)' },
  { value: 'hqx', label: 'hqx (pixel art upscale)' },
  { value: 'magicKernel', label: 'Magic Kernel' },
  { value: 'magicKernelSharp2013', label: 'Magic Kernel Sharp 2013' },
  { value: 'magicKernelSharp2021', label: 'Magic Kernel Sharp 2021' },
];

const ENGINES: { value: CompressEngine; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'wasm', label: 'WASM' },
  { value: 'canvas', label: 'Canvas' },
];

const SUBSAMPLING: SubsamplingMode[] = ['4:4:4', '4:2:2', '4:2:0', '4:1:1'];

export function AdvancedPanel({ value, onChange, showResizeMethod, showCompressTuning, showConvertQuality }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="advanced">
      <button type="button" className="advanced__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Settings2 size={14} />
        Advanced
        <ChevronDown size={14} className={`advanced__chevron${open ? ' advanced__chevron--open' : ''}`} />
      </button>

      {open && (
        <div className="advanced__body">
          {showResizeMethod && (
            <label className="field">
              <span className="field__label">Resampling method</span>
              <select value={value.resizeMethod} onChange={(e) => onChange({ resizeMethod: e.target.value as ResizeMethod })}>
                {RESIZE_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {showCompressTuning && (
            <>
              <label className="field">
                <span className="field__label">Compression engine</span>
                <div className="segmented">
                  {ENGINES.map((e) => (
                    <button key={e.value} type="button" className={value.compressEngine === e.value ? 'is-active' : ''} onClick={() => onChange({ compressEngine: e.value })}>
                      {e.label}
                    </button>
                  ))}
                </div>
              </label>
              <div className="dims-row">
                <label className="field">
                  <span className="field__label">
                    Minimum quality <em>{value.minQuality}</em>
                  </span>
                  <Slider min={1} max={100} step={1} value={[value.minQuality]} onValueChange={([v]) => onChange({ minQuality: v })} />
                </label>
                <label className="field">
                  <span className="field__label">Color detail</span>
                  <select value={value.subsampling} onChange={(e) => onChange({ subsampling: e.target.value as SubsamplingMode })}>
                    {SUBSAMPLING.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="checkline">
                <input type="checkbox" checked={value.progressive} onChange={(e) => onChange({ progressive: e.target.checked })} />
                Progressive JPEG (loads gradually on slow connections)
              </label>
              <label className="checkline">
                <input type="checkbox" checked={value.allowMiss} onChange={(e) => onChange({ allowMiss: e.target.checked })} />
                Accept the closest result if the target size can't be reached
              </label>
            </>
          )}

          {showConvertQuality && (
            <label className="field">
              <span className="field__label">
                Output quality <em>{value.convertQuality}</em>
              </span>
              <Slider min={1} max={100} step={1} value={[value.convertQuality]} onValueChange={([v]) => onChange({ convertQuality: v })} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
