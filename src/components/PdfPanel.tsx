import { Layers } from 'lucide-react';
import type { PdfExtractedPage } from '../engine/types';
import { formatBytes } from '../state/pipeline';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Slider } from './ui/slider';
import { InfoTip } from './InfoTip';

export interface PdfPageVM extends PdfExtractedPage {
  url: string;
}

interface Props {
  pageCount: number | null;
  pageNumber: number;
  onPageNumberChange: (n: number) => void;
  quality: number;
  onQualityChange: (q: number) => void;
  maxRenderDim: number;
  onMaxRenderDimChange: (d: number) => void;
  onExtract: () => void;
  extracting: boolean;
  page: PdfPageVM | null;
  onChangePage: () => void;
}

export function PdfPanel({
  pageCount,
  pageNumber,
  onPageNumberChange,
  quality,
  onQualityChange,
  maxRenderDim,
  onMaxRenderDimChange,
  onExtract,
  extracting,
  page,
  onChangePage,
}: Props) {
  if (page) {
    return (
      <div className="file-row">
        <div className="file-row__icon">
          <Layers size={16} />
        </div>
        <div className="file-row__text">
          <div className="file-row__name">
            Page {page.pageNumber}
            {pageCount ? ` of ${pageCount}` : ''}
          </div>
          <div className="file-row__meta">{formatBytes(page.jpeg.byteLength)}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onChangePage}>
          Change page
        </Button>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section__head">
        <h3>Pick a page</h3>
        <p className="flex items-center gap-1">
          {pageCount === null ? (
            'Reading the PDF…'
          ) : (
            <>
              {pageCount} page{pageCount === 1 ? '' : 's'} found.
              <InfoTip>This app works on one page at a time. Pick the page you want, then extract it below.</InfoTip>
            </>
          )}
        </p>
      </div>

      <div className="dims-row">
        <label className="field">
          <span className="field__label">Page number</span>
          <Input
            type="number"
            min={1}
            max={pageCount ?? undefined}
            value={pageNumber}
            onChange={(e) => onPageNumberChange(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <label className="field">
          <span className="field__label">
            Image quality <em>{quality}</em>
          </span>
          <Slider min={1} max={100} step={1} value={[quality]} onValueChange={([v]) => onQualityChange(v)} />
        </label>
      </div>
      <label className="field" style={{ marginTop: 10 }}>
        <span className="field__label">
          Maximum resolution <em>px, longest side</em>
        </span>
        <Input
          type="number"
          min={64}
          step={64}
          value={maxRenderDim}
          onChange={(e) => onMaxRenderDimChange(Math.max(64, Number(e.target.value) || 64))}
        />
      </label>

      <Button type="button" className="btn--block" style={{ marginTop: 12 }} onClick={onExtract} disabled={extracting || pageCount === null}>
        <Layers size={14} />
        {extracting ? 'Reading…' : `Use page ${pageNumber}`}
      </Button>
    </div>
  );
}
