import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Loader2, X, Crop, Minimize2, ArrowRightLeft } from 'lucide-react';

import { EngineClient, EngineError, type EngineEvent } from './engine/client';
import type { InspectInfo, ImageFormat, RunResult } from './engine/types';
import {
  buildPipelineConfig,
  defaultSimpleState,
  isNoopConfig,
  needsCrop,
  targetLocksFormat,
  hidesSizeReduction,
  EXPORT_TARGETS,
  bytesToBlob,
  type SimpleState,
} from './state/pipeline';
import { useTheme } from './hooks/useTheme';
import { useDrive } from './drive/useDrive';

import { AppShell, type AppTab } from './components/AppShell';
import { InfoTip } from './components/InfoTip';
import { Dropzone } from './components/Dropzone';
import { PdfPanel, type PdfPageVM } from './components/PdfPanel';
import { DimensionsControl } from './components/DimensionsControl';
import { ExportTargetControl } from './components/ExportTargetControl';
import { SizeReductionControl } from './components/SizeReductionControl';
import { AdvancedPanel } from './components/AdvancedPanel';
import { PreviewResult } from './components/PreviewResult';
import { VaultPage } from './components/VaultPage';
import { LegalLinks } from './components/LegalLinks';
import { Button } from './components/ui/button';
import type { LogLine } from './components/LogConsole';

type EngineStatus = 'loading' | 'ready' | 'error';
type StageStatus = 'pending' | 'active' | 'done' | 'error';

const STAGE_LABELS: Record<string, string> = {
  resize: 'Resizing…',
  crop: 'Cropping…',
  compress: 'Shrinking…',
  convert: 'Converting…',
  bind: 'Building your PDF…',
};

const PREVIEWABLE_MIME: Partial<Record<ImageFormat, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export default function App() {
  // Keeps <html data-theme> in sync with the OS preference; no manual override.
  useTheme();
  const [tab, setTab] = useState<AppTab>('studio');

  // Keep the browser tab title short: the brand on Studio, "Vault | FitForm" on Vault.
  useEffect(() => {
    document.title = tab === 'vault' ? 'Vault | FitForm' : 'FitForm';
  }, [tab]);

  // Lifted to the top so both the Studio and Vault tabs share one Drive
  // session — this is what makes "open a vault file in Studio" and "save a
  // Studio result to the vault" work without reconnecting or re-fetching.
  const drive = useDrive();

  const engineRef = useRef<EngineClient | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('loading');

  const [log, setLog] = useState<LogLine[]>([]);
  const logQueueRef = useRef<LogLine[]>([]);
  const logFlushHandleRef = useRef<number | null>(null);
  const flushLog = useCallback(() => {
    logFlushHandleRef.current = null;
    if (logQueueRef.current.length === 0) return;
    const queued = logQueueRef.current;
    logQueueRef.current = [];
    setLog((l) => [...l, ...queued].slice(-150));
  }, []);
  useEffect(() => () => {
    if (logFlushHandleRef.current != null) cancelAnimationFrame(logFlushHandleRef.current);
  }, []);
  const pushLog = useCallback((stage: string, message: string) => {
    logQueueRef.current.push({ stage, message });
    if (logFlushHandleRef.current == null) {
      logFlushHandleRef.current = requestAnimationFrame(flushLog);
    }
  }, [flushLog]);
  const onEngineEvent = useCallback((e: EngineEvent) => {
    if (e.type === 'log') pushLog(e.stage, e.message);
  }, [pushLog]);

  // ── source file ──────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<'image' | 'pdf' | null>(null);
  const [sourceBytesRaw, setSourceBytesRaw] = useState<Uint8Array | null>(null);

  // ── pdf state ────────────────────────────────────────────────────────
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfQuality, setPdfQuality] = useState(85);
  const [pdfMaxRenderDim, setPdfMaxRenderDim] = useState(2200);
  const [pdfExtracting, setPdfExtracting] = useState(false);
  const [pdfPage, setPdfPage] = useState<PdfPageVM | null>(null);
  const pdfUrlRef = useRef<string | null>(null);

  // ── working image (what the pipeline actually runs on) ──────────────
  const [workingBytes, setWorkingBytes] = useState<Uint8Array | null>(null);
  const [workingLabel, setWorkingLabel] = useState('image');
  const [inspectInfo, setInspectInfo] = useState<InspectInfo | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  // ── simple pipeline state ────────────────────────────────────────────
  const [simple, setSimple] = useState<SimpleState>(defaultSimpleState());

  // ── run state ────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [stageStatus, setStageStatus] = useState<Record<string, StageStatus>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<{ message: string; tool?: string; code?: string } | null>(null);

  const runIdRef = useRef(0);
  const runningRef = useRef(false);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  const invalidateActiveRun = useCallback(() => {
    runIdRef.current += 1;
    if (runningRef.current) {
      const engine = engineRef.current;
      if (engine) engine.cancel((e) => onEngineEvent(e)).catch(() => {});
      setRunning(false);
      setStageStatus({});
    }
  }, [onEngineEvent]);

  // ── boot the engine once ─────────────────────────────────────────────
  useEffect(() => {
    const engine = new EngineClient();
    engineRef.current = engine;
    engine.onCrash = (e) => {
      setEngineStatus('error');
      pushLog('error', `Engine worker crashed: ${e.message}`);
    };
    setEngineStatus('loading');
    engine
      .init((e) => onEngineEvent(e))
      .then(() => setEngineStatus('ready'))
      .catch((e: EngineError) => {
        setEngineStatus('error');
        pushLog('error', e.message);
      });
    return () => {
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRestartEngine = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setEngineStatus('loading');
    engine
      .restart((e) => onEngineEvent(e))
      .then(() => setEngineStatus('ready'))
      .catch((e: EngineError) => {
        setEngineStatus('error');
        pushLog('error', e.message);
      });
  }, [onEngineEvent, pushLog]);

  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  const resetDerivedState = useCallback(() => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    pdfUrlRef.current = null;
    setPdfPage(null);
    setPdfPageCount(null);
    setPdfPageNumber(1);
    setWorkingBytes(null);
    setInspectInfo(null);
    setResult(null);
    setRunError(null);
    setStageStatus({});
    setSimple(defaultSimpleState());
  }, []);

  const handleFile = useCallback(
    async (f: File) => {
      invalidateActiveRun();
      resetDerivedState();
      const buf = new Uint8Array(await f.arrayBuffer());
      setFile(f);
      setSourceBytesRaw(buf);
      if (isPdfBytes(buf)) {
        setSourceKind('pdf');
      } else {
        setSourceKind('image');
        setWorkingBytes(buf);
        setWorkingLabel(f.name);
      }
    },
    [resetDerivedState, invalidateActiveRun],
  );

  // What the Vault's "Open in Studio" button calls: hands a downloaded
  // Drive file straight into the same pipeline a local drop would use, and
  // switches the view over so the person actually sees it land.
  const handleOpenInStudio = useCallback(
    (f: File) => {
      setTab('studio');
      void handleFile(f);
    },
    [handleFile],
  );

  const handleSaveToVault = useCallback(
    async (data: Uint8Array, filename: string, mime: string) => {
      await drive.uploadBytes(data, filename, mime);
    },
    [drive],
  );

  const handleClearFile = useCallback(() => {
    invalidateActiveRun();
    resetDerivedState();
    setFile(null);
    setSourceKind(null);
    setSourceBytesRaw(null);
  }, [resetDerivedState, invalidateActiveRun]);

  // ── fetch pdf page count once the engine is ready ────────────────────
  useEffect(() => {
    if (sourceKind !== 'pdf' || !sourceBytesRaw || engineStatus !== 'ready' || pdfPageCount !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine
      .pdfPageCount(sourceBytesRaw, onEngineEvent)
      .then(setPdfPageCount)
      .catch((e: EngineError) => pushLog('error', `pdf-info: ${e.message}`));
  }, [sourceKind, sourceBytesRaw, engineStatus, pdfPageCount, onEngineEvent, pushLog]);

  // ── inspect the working image whenever it changes ────────────────────
  useEffect(() => {
    if (!workingBytes || engineStatus !== 'ready') {
      setInspectInfo(null);
      return;
    }
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    engine
      .inspect(workingBytes)
      .then((info) => {
        if (!cancelled) setInspectInfo(info);
      })
      .catch(() => {
        if (!cancelled) setInspectInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workingBytes, engineStatus]);

  // ── build a preview object URL for the current working image ────────
  useEffect(() => {
    if (!workingBytes) {
      setSourceUrl(null);
      return;
    }
    const mime = inspectInfo?.format ? PREVIEWABLE_MIME[inspectInfo.format] : undefined;
    if (!mime) {
      const url = URL.createObjectURL(bytesToBlob(workingBytes));
      setSourceUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    const url = URL.createObjectURL(bytesToBlob(workingBytes, mime));
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [workingBytes, inspectInfo?.format]);

  const handleExtract = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !sourceBytesRaw || !file) return;
    invalidateActiveRun();
    setPdfExtracting(true);
    setResult(null);
    setRunError(null);
    try {
      const pages = await engine.pdfExtract(sourceBytesRaw, { page: pdfPageNumber, quality: pdfQuality, maxRenderDim: pdfMaxRenderDim }, onEngineEvent);
      const extracted = pages[0];
      if (!extracted) return;
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(bytesToBlob(extracted.jpeg, 'image/jpeg'));
      pdfUrlRef.current = url;
      setPdfPage({ ...extracted, url });
      setWorkingBytes(extracted.jpeg);
      setWorkingLabel(`${baseName(file.name)}-p${extracted.pageNumber}.jpg`);
      setResult(null);
      setRunError(null);
      setStageStatus({});
    } catch (e) {
      pushLog('error', e instanceof EngineError ? e.message : String(e));
    } finally {
      setPdfExtracting(false);
    }
  }, [sourceBytesRaw, file, pdfPageNumber, pdfQuality, pdfMaxRenderDim, onEngineEvent, pushLog, invalidateActiveRun]);

  const handleChangePage = useCallback(() => {
    invalidateActiveRun();
    setPdfPage(null);
    setWorkingBytes(null);
    setInspectInfo(null);
    setResult(null);
    setRunError(null);
    setStageStatus({});
  }, [invalidateActiveRun]);

  const pipelineConfig = useMemo(() => buildPipelineConfig(simple), [simple]);
  const noop = useMemo(() => isNoopConfig(simple), [simple]);

  const handleRun = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !workingBytes || engineStatus !== 'ready') return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const myRunId = (runIdRef.current += 1);
    setRunning(true);
    setResult(null);
    setRunError(null);
    setStageStatus({ source: 'done' });
    try {
      const r = await engine.run(workingBytes, workingLabel, pipelineConfig, (e) => {
        if (runIdRef.current !== myRunId) return;
        if (e.type === 'log') pushLog(e.stage, e.message);
        else setStageStatus((s) => ({ ...s, [e.stage]: e.status === 'start' ? 'active' : e.status === 'done' ? 'done' : 'error' }));
      });
      if (runIdRef.current !== myRunId) return;
      setResult(r);
    } catch (e) {
      if (runIdRef.current !== myRunId) return;
      if (e instanceof EngineError && e.code === 'CANCELLED') {
        setStageStatus({});
        pushLog('cancel', 'Run cancelled.');
      } else if (e instanceof EngineError) {
        setRunError({ message: e.message, tool: e.tool, code: e.code });
      } else {
        setRunError({ message: String(e) });
      }
    } finally {
      if (runIdRef.current === myRunId) setRunning(false);
    }
  }, [workingBytes, workingLabel, pipelineConfig, engineStatus, pushLog]);

  const handleCancel = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !running || cancelling) return;
    setCancelling(true);
    try {
      await engine.cancel((e) => onEngineEvent(e));
    } catch (e) {
      pushLog('error', e instanceof EngineError ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }, [running, cancelling, onEngineEvent, pushLog]);

  const activeStageKey = Object.entries(stageStatus).find(([, v]) => v === 'active')?.[0];
  const activeStageLabel = activeStageKey ? STAGE_LABELS[activeStageKey] ?? 'Working…' : null;

  const canRun = !!workingBytes && engineStatus === 'ready' && !running && !noop;

  const statusLabel = engineStatus === 'loading' ? 'Getting ready…' : engineStatus === 'error' ? 'Something went wrong' : 'Ready';

  const locksFormat = targetLocksFormat(simple.exportTarget);
  const hideReduce = hidesSizeReduction(simple.exportTarget);
  const cropping = needsCrop(simple);
  const reducingNow = simple.reduceSize && !hideReduce;

  return (
    <AppShell
      tab={tab}
      onTabChange={setTab}
      footer={<LegalLinks />}
      headerRight={
        <>
          {tab === 'studio' && (
            <div className={`engine-status engine-status--${engineStatus}`}>
              <span className="engine-status__dot" />
              {statusLabel}
              {engineStatus === 'error' && (
                <button type="button" className="engine-status__retry" onClick={handleRestartEngine}>
                  Restart
                </button>
              )}
            </div>
          )}
          {tab === 'vault' && drive.status === 'signed-in' && (
            <div className="engine-status engine-status--ready hidden sm:inline-flex">
              <span className="engine-status__dot" />
              Connected
            </div>
          )}
        </>
      }
    >
      {tab === 'vault' ? (
        <VaultPage drive={drive} onOpenInStudio={handleOpenInStudio} />
      ) : (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-4 sm:p-6 lg:flex-row lg:items-start lg:gap-8 lg:px-8 lg:py-8">
          <div className={`flex min-w-0 flex-1 flex-col gap-4${file && !workingBytes ? ' lg:mx-auto lg:max-w-2xl' : ''}`}>
            {!file ? (
              <div className="hero">
                <h1 className="hero__title">Get your file the right size</h1>
                <Dropzone file={file} onFile={handleFile} onClear={handleClearFile} />
                <p className="hero__sub">Resize, shrink, or convert a photo or PDF, right in your browser. Nothing is uploaded anywhere.</p>
                {drive.status === 'signed-in' && drive.files.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setTab('vault')}>
                    Or pick a file from your Vault
                  </Button>
                )}
                <ul className="hero__features">
                  <li>
                    <span className="hero__feature-icon">
                      <Crop size={16} />
                    </span>
                    <strong>Resize &amp; crop</strong>
                    <span>Exact pixels, with a crop you control.</span>
                  </li>
                  <li>
                    <span className="hero__feature-icon">
                      <Minimize2 size={16} />
                    </span>
                    <strong>Shrink to a size</strong>
                    <span>Compress until it fits a target you set.</span>
                  </li>
                  <li>
                    <span className="hero__feature-icon">
                      <ArrowRightLeft size={16} />
                    </span>
                    <strong>Convert formats</strong>
                    <span>JPG, PNG, WebP, BMP, TGA, or PDF.</span>
                  </li>
                </ul>
              </div>
            ) : (
              <>
                <Dropzone file={file} onFile={handleFile} onClear={handleClearFile} />
                {sourceKind === 'pdf' && (
                  <PdfPanel
                    pageCount={pdfPageCount}
                    pageNumber={pdfPageNumber}
                    onPageNumberChange={setPdfPageNumber}
                    quality={pdfQuality}
                    onQualityChange={setPdfQuality}
                    maxRenderDim={pdfMaxRenderDim}
                    onMaxRenderDimChange={setPdfMaxRenderDim}
                    onExtract={handleExtract}
                    extracting={pdfExtracting}
                    page={pdfPage}
                    onChangePage={handleChangePage}
                  />
                )}
                {workingBytes && (
                  <PreviewResult
                    sourceUrl={sourceUrl}
                    sourceBytes={workingBytes.byteLength}
                    sourceInfo={inspectInfo}
                    isPdfSource={sourceKind === 'pdf'}
                    result={result}
                    error={runError}
                    running={running}
                    activeStageLabel={activeStageLabel}
                    log={log}
                    onSaveToVault={handleSaveToVault}
                    vaultConnected={drive.status === 'signed-in'}
                  />
                )}
              </>
            )}
          </div>

          {workingBytes && (
            // Desktop: a sticky settings rail. The controls scroll inside it
            // when they outgrow the window, while the Process button stays
            // pinned underneath so it's always in reach. Below `lg` it's a
            // plain stacked column, exactly as before.
            <div
              aria-label="Settings"
              className="flex w-full flex-col gap-4 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:w-[380px] lg:shrink-0"
            >
              <div className="rail-scroll flex flex-col gap-4 lg:-mb-4 lg:-mr-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pb-6 lg:pr-2">
                <DimensionsControl
                  width={simple.width}
                  height={simple.height}
                  cropAnchor={simple.cropAnchor}
                  cropMode={simple.cropMode}
                  cropOffset={simple.cropOffset}
                  cropRect={simple.cropRect}
                  sourceUrl={sourceKind === 'image' ? sourceUrl : null}
                  sourceWidth={inspectInfo?.width}
                  sourceHeight={inspectInfo?.height}
                  onChange={(patch) => setSimple((s) => ({ ...s, ...patch }))}
                />

                <ExportTargetControl value={simple.exportTarget} onChange={(exportTarget) => setSimple((s) => ({ ...s, exportTarget }))} />

                {simple.exportTarget === 'pdf' && (
                  <p className="hint-text">
                    PDF export uses a single JPEG page.
                    <InfoTip>Turn on "Shrink file size" below to control how large that page, and the PDF, ends up.</InfoTip>
                  </p>
                )}

                {!hideReduce && (
                  <SizeReductionControl
                    enabled={simple.reduceSize}
                    onEnabledChange={(reduceSize) => setSimple((s) => ({ ...s, reduceSize }))}
                    targetKb={simple.targetKb}
                    onTargetKbChange={(targetKb) => setSimple((s) => ({ ...s, targetKb }))}
                  />
                )}

                {simple.exportTarget === 'same' && reducingNow && (
                  <p className="hint-text">
                    You'll get a JPG back, even from a PNG or WebP.
                    <InfoTip>
                      Shrinking always re-encodes as JPG, the only format that can hit an exact size. Since "Same as original" is selected, that's
                      what comes back.
                    </InfoTip>
                  </p>
                )}

                {hideReduce && (
                  <p className="hint-text">
                    {EXPORT_TARGETS.find((t) => t.value === simple.exportTarget)?.label} can't be shrunk to a target size.
                    <InfoTip>
                      This format doesn't use lossy compression, so the export usually comes out larger than the original. Pick JPG or WebP for a
                      specific file size.
                    </InfoTip>
                  </p>
                )}

                <AdvancedPanel
                  value={simple.advanced}
                  onChange={(patch) => setSimple((s) => ({ ...s, advanced: { ...s.advanced, ...patch } }))}
                  showResizeMethod={!!simple.width !== !!simple.height}
                  showCompressTuning={reducingNow || cropping}
                  showConvertQuality={!locksFormat && simple.exportTarget !== 'same'}
                />

              </div>

              <div className="run-bar lg:shrink-0 lg:rounded-xl lg:border-2 lg:border-border lg:bg-card lg:p-2 lg:shadow-hard">
                <div className="run-row flex gap-2">
                  <Button className="btn--run lg:border-transparent lg:shadow-none" onClick={handleRun} disabled={!canRun}>
                    {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={15} />}
                    {running ? 'Processing…' : 'Process image'}
                  </Button>
                  {running && (
                    <Button variant="outline" className="btn--cancel" onClick={handleCancel} disabled={cancelling}>
                      <X size={15} />
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                </div>
                {noop && <p className="hint-text hint-text--center">Set a dimension, size, or format above to get started.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
