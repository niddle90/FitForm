import type {
  WorkerRequest,
  WorkerMessage,
  WorkerResponsePayload,
  PipelineConfig,
  RunResult,
  PdfExtractedPage,
  InspectInfo,
} from './types';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EngineRequest = DistributiveOmit<WorkerRequest, 'id'>;

export class EngineError extends Error {
  tool?: string;
  code?: string;
  constructor(message: string, tool?: string, code?: string) {
    super(message);
    this.name = 'EngineError';
    this.tool = tool;
    this.code = code;
  }
}

export type EngineEvent =
  | { type: 'log'; stage: string; message: string }
  | { type: 'progress'; stage: string; status: 'start' | 'done' | 'error' };

type Pending = {
  resolve: (payload: WorkerResponsePayload) => void;
  reject: (err: EngineError) => void;
  onEvent?: (e: EngineEvent) => void;
};

/**
 * Thin RPC layer over the engine worker. Every call gets its own request
 * id; log/progress messages tagged with that id are streamed to the
 * caller's onEvent callback (if given) while the call is in flight, so
 * the UI can show exactly what imaging is doing without blocking on
 * the final result.
 *
 * Worker lifecycle: a crashed worker (e.g. an uncaught exception during
 * WASM init, or the browser reclaiming it under memory pressure) used to
 * leave this client permanently unusable — `onerror` rejected whatever
 * was in flight but nothing ever told the caller the *client itself* was
 * now dead, so every future call would fail the same way with no way to
 * recover short of reloading the page. `onCrash` (set once, from the
 * caller) now fires whenever that happens, and `restart()` tears down
 * the dead worker and boots a fresh one in its place, re-running `init`
 * so the caller can get back to a working engine without a full reload.
 */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** Called once per crash, after every pending call has been rejected. Not called by `dispose()`. */
  onCrash: ((err: EngineError) => void) | null = null;

  constructor() {
    this.worker = this.spawnWorker();
  }

  private spawnWorker(): Worker {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => this.handleMessage(ev.data);
    worker.onerror = (ev) => {
      // A raw worker-level error (e.g. a syntax error during module
      // evaluation, or the worker being killed outright) has no request
      // id to route to — fail every pending call so nothing hangs
      // silently, then tell the caller the client needs a restart.
      const err = new EngineError(ev.message || 'engine worker crashed');
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.onCrash?.(err);
    };
    return worker;
  }

  /**
   * Recreates the underlying worker and re-initializes imaging on
   * it. Safe to call after a crash (or speculatively, any time) — any
   * calls still in flight on the old worker are rejected first, same as
   * a crash. Returns once the new worker's `init` has completed, so
   * awaiting this is enough to know the client is usable again.
   */
  async restart(onEvent?: (e: EngineEvent) => void, rejectReason: { message: string; code?: string } = { message: 'engine restarting' }): Promise<void> {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    const staleErr = new EngineError(rejectReason.message, undefined, rejectReason.code);
    for (const [, p] of this.pending) p.reject(staleErr);
    this.pending.clear();
    this.worker.terminate();
    this.worker = this.spawnWorker();
    await this.init(onEvent);
  }

  /**
   * Cancels whatever's currently in flight (and anything queued behind
   * it) by terminating the worker outright and booting a fresh one.
   * There's no cooperative cancellation inside imaging to hook into
   * — once a WASM call like compress starts, it runs synchronously to
   * completion on the worker's single JS thread (a large target-size
   * bisection or a big PDF render doesn't yield in between), so nothing
   * short of killing the worker actually stops it partway through. This
   * is the "one EngineClient per operation, terminate on abandon"
   * approach the original code review suggested for the mobile-memory
   * concern, applied per-call via `restart()` instead of forcing every
   * caller to juggle multiple EngineClient instances. A no-op if nothing
   * is currently pending.
   */
  async cancel(onEvent?: (e: EngineEvent) => void): Promise<void> {
    if (this.pending.size === 0) return;
    await this.restart(onEvent, { message: 'operation cancelled', code: 'CANCELLED' });
  }

  private handleMessage(msg: WorkerMessage) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.type === 'log' || msg.type === 'progress') {
      pending.onEvent?.(
        msg.type === 'log' ? { type: 'log', stage: msg.stage, message: msg.message } : { type: 'progress', stage: msg.stage, status: msg.status },
      );
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'result') {
      pending.resolve(msg.payload);
    } else {
      pending.reject(new EngineError(msg.message, msg.tool, msg.code));
    }
  }

  private call(req: EngineRequest, onEvent?: (e: EngineEvent) => void, transfer?: Transferable[]): Promise<WorkerResponsePayload> {
    const id = this.nextId++;
    const full = { ...req, id } as WorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.worker.postMessage(full, transfer ?? []);
    });
  }

  /** Loads every codec + WASM engine once. Safe to call multiple times (idempotent on the worker side). */
  async init(onEvent?: (e: EngineEvent) => void): Promise<void> {
    await this.call({ type: 'init' }, onEvent);
  }

  async inspect(bytes: Uint8Array, onEvent?: (e: EngineEvent) => void): Promise<InspectInfo> {
    const copy = bytes.slice();
    const payload = await this.call({ type: 'inspect', bytes: copy }, onEvent, [copy.buffer]);
    if (payload.kind !== 'inspect') throw new EngineError('unexpected response');
    return payload.info;
  }

  async pdfPageCount(bytes: Uint8Array, onEvent?: (e: EngineEvent) => void): Promise<number> {
    const copy = bytes.slice();
    const payload = await this.call({ type: 'pdf-info', bytes: copy }, onEvent, [copy.buffer]);
    if (payload.kind !== 'pdf-info') throw new EngineError('unexpected response');
    return payload.pageCount;
  }

  async pdfExtract(
    bytes: Uint8Array,
    opts: { page: number | null; quality: number; maxRenderDim: number },
    onEvent?: (e: EngineEvent) => void,
  ): Promise<PdfExtractedPage[]> {
    const copy = bytes.slice();
    const payload = await this.call(
      { type: 'pdf-extract', bytes: copy, page: opts.page, quality: opts.quality, maxRenderDim: opts.maxRenderDim },
      onEvent,
      [copy.buffer],
    );
    if (payload.kind !== 'pdf-extract') throw new EngineError('unexpected response');
    return payload.pages;
  }

  async run(bytes: Uint8Array, filenameHint: string, config: PipelineConfig, onEvent?: (e: EngineEvent) => void): Promise<RunResult> {
    const copy = bytes.slice();
    const payload = await this.call({ type: 'run', bytes: copy, filenameHint, config }, onEvent, [copy.buffer]);
    if (payload.kind !== 'run') throw new EngineError('unexpected response');
    return payload.result;
  }

  dispose() {
    this.worker.terminate();
  }
}
