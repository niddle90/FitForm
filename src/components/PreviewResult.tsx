import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, AlertTriangle, FileText, CloudUpload, Check, Pencil } from 'lucide-react';
import type { RunResult, InspectInfo } from '../engine/types';
import { formatBytes, pctChange, bytesToBlob } from '../state/pipeline';
import { LogConsole, type LogLine } from './LogConsole';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface Props {
  sourceUrl: string | null;
  sourceBytes: number | null;
  sourceInfo: InspectInfo | null;
  isPdfSource: boolean;
  result: RunResult | null;
  error: { message: string; tool?: string; code?: string } | null;
  running: boolean;
  activeStageLabel: string | null;
  log: LogLine[];
  /** Optional: lets the studio save its output straight into the connected Drive vault. */
  onSaveToVault?: (data: Uint8Array, filename: string, mime: string) => Promise<void> | void;
  vaultConnected?: boolean;
}

export function PreviewResult({
  sourceUrl,
  sourceBytes,
  sourceInfo,
  isPdfSource,
  result,
  error,
  running,
  activeStageLabel,
  log,
  onSaveToVault,
  vaultConnected,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filename, setFilename] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const downloadRef = useRef<HTMLAnchorElement>(null);

  const resultUrl = useMemo(() => {
    if (!result) return null;
    // Built for every result, not just images: this is also what the
    // Download link's href uses, so a PDF/other non-previewable export
    // still gets a real, working download URL — only the <img> preview
    // below is conditional on the mime type.
    return URL.createObjectURL(bytesToBlob(result.data, result.mime));
  }, [result]);
  const resultIsImage = result?.mime.startsWith('image/') ?? false;

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  useEffect(() => {
    setSaved(false);
    setFilename(result?.filename ?? '');
    setRenaming(false);
  }, [result]);

  // Once a run finishes, bring the download button into view and focus it,
  // so finishing a run always lands the person somewhere they can act on.
  useEffect(() => {
    if (!running && result && downloadRef.current) {
      downloadRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      downloadRef.current.focus({ preventScroll: true });
    }
  }, [running, result]);

  const finalBytes = result?.data.byteLength ?? null;
  const delta = result && sourceBytes ? pctChange(sourceBytes, finalBytes!) : null;
  const isDown = result && sourceBytes ? finalBytes! <= sourceBytes : true;

  const handleSaveToVault = async () => {
    if (!result || !onSaveToVault || saving) return;
    setSaving(true);
    try {
      await onSaveToVault(result.data, filename || result.filename, result.mime);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const startRenaming = () => {
    setNameDraft(filename);
    setRenaming(true);
  };
  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) setFilename(trimmed);
    setRenaming(false);
  };

  return (
    <div className="preview">
      <div className={`preview__frames${result ? ' preview__frames--split' : ''}`}>
        <div className="preview__frame">
          <div className="preview__media">
            {sourceUrl ? (
              <img src={sourceUrl} alt="Original" />
            ) : (
              <div className="preview__placeholder">
                <FileText size={28} />
              </div>
            )}
          </div>
          <div className="preview__caption">
            <span>{result ? 'Before' : isPdfSource ? 'Selected page' : 'Your photo'}</span>
            <span className="preview__caption-meta">
              {sourceBytes !== null && formatBytes(sourceBytes)}
              {sourceInfo?.width ? ` · ${sourceInfo.width}×${sourceInfo.height}` : ''}
            </span>
          </div>
        </div>

        {(result || running) && (
          <div className="preview__frame">
            <div className="preview__media">
              {running && (
                <div className="preview__placeholder preview__placeholder--busy">
                  <span className="preview__spinner" />
                  <span>{activeStageLabel ?? 'Working…'}</span>
                </div>
              )}
              {!running && result && resultIsImage && resultUrl && <img src={resultUrl} alt="Result" />}
              {!running && result && !resultIsImage && (
                <div className="preview__placeholder">
                  <FileText size={28} />
                  <span>{result.filename}</span>
                </div>
              )}
            </div>
            {!running && result && (
              <div className="preview__caption">
                <span>After</span>
                <span className="preview__caption-meta">
                  {formatBytes(finalBytes!)}
                  {delta && <span className={`preview__delta preview__delta--${isDown ? 'down' : 'up'}`}> {delta}</span>}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="callout callout--error">
          <AlertTriangle size={15} />
          <div>
            <strong>{error.tool ? `Couldn't finish (${error.tool})` : "Couldn't finish"}</strong>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {result && (
        <div className="result-name">
          {renaming ? (
            <Input
              autoFocus
              className="text-input--inline h-8"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={commitRename}
            />
          ) : (
            <button type="button" className="result-name__display" onClick={startRenaming} title="Rename before saving">
              <span className="min-w-0 truncate">{filename}</span>
              <Pencil size={12} />
            </button>
          )}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild className="btn--block min-w-0 flex-1">
            <a ref={downloadRef} href={resultUrl ?? '#'} download={filename || result.filename} title={`Download ${filename || result.filename}`}>
              <Download size={15} />
              <span className="min-w-0 truncate">Download</span>
            </a>
          </Button>
          {onSaveToVault && (
            <Button
              type="button"
              variant={vaultConnected ? 'outline' : 'ghost'}
              disabled={!vaultConnected || saving}
              onClick={handleSaveToVault}
              title={vaultConnected ? 'Save this result to your Drive vault' : 'Connect Google Drive in Vault to enable this'}
            >
              {saved ? <Check size={15} /> : <CloudUpload size={15} />}
              {saving ? 'Saving…' : saved ? 'Saved to Vault' : 'Save to Vault'}
            </Button>
          )}
        </div>
      )}

      {(result || log.length > 0) && (
        <div className="details">
          <button type="button" className="details__toggle" onClick={() => setDetailsOpen((o) => !o)} aria-expanded={detailsOpen}>
            Technical details
            <ChevronDown size={14} className={`advanced__chevron${detailsOpen ? ' advanced__chevron--open' : ''}`} />
          </button>
          {detailsOpen && (
            <div className="details__body">
              {result && (
                <table className="result-table">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Size</th>
                      <th>Dimensions</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stages.map((s, i) => (
                      <tr key={i}>
                        <td>{s.label}</td>
                        <td>{formatBytes(s.bytes)}</td>
                        <td>{s.width && s.height ? `${s.width}×${s.height}` : '–'}</td>
                        <td>
                          {s.format ? s.format.toUpperCase() : ''}
                          {s.extra?.engine ? ` · ${s.extra.engine}` : ''}
                          {s.extra?.quality !== undefined ? ` · q${s.extra.quality}` : ''}
                          {s.extra?.metTarget === false ? ' · missed target' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <LogConsole lines={log} live={running} />
            </div>
          )}
        </div>
      )}

      {!sourceUrl && !isPdfSource && !result && <div className="empty-state">Upload a photo to get started.</div>}
    </div>
  );
}
