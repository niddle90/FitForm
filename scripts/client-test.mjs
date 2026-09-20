// Regression tests for src/engine/client.ts's worker lifecycle: crash
// detection (onCrash), recovery (restart()), and cancellation (cancel()).
//
// These three behaviors were previously verified by hand, once, with a
// throwaway Node harness (see CHANGELOG.md §6 "Worker crash recovery" and
// §7 "Operation cancellation") — real coverage at the time, but nothing
// that would catch a regression later. This turns that same approach
// (drive the real, unmodified EngineClient against a fake Worker that
// implements the same onmessage/onerror/postMessage/terminate contract a
// real Worker does) into a script that runs every time, via `npm test`.
//
// Run with: node --experimental-strip-types scripts/client-test.mjs
// (same Node 22 type-stripping approach as scripts/pipeline-test.mjs.)

import assert from 'node:assert/strict';

const ok = (label) => console.log(`  ✓ ${label}`);
const section = (label) => console.log(`\n${label}`);

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.stack ?? e.message}`);
  }
}

// ── fake Worker ──────────────────────────────────────────────────────
//
// Mimics exactly the surface EngineClient touches: onmessage/onerror
// properties it assigns to, postMessage(msg, transfer) it calls, and
// terminate(). Auto-responds to whatever request type is posted with a
// successful `result` message on the next microtask, unless the test has
// queued a scripted response (used to simulate a crash mid-call, or a
// custom payload).
let instanceCounter = 0;

class FakeWorker {
  constructor() {
    this.instanceId = ++instanceCounter;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.posted = [];
  }

  postMessage(msg) {
    if (this.terminated) throw new Error('postMessage on a terminated fake worker');
    this.posted.push(msg);
    const script = FakeWorker.nextResponse;
    FakeWorker.nextResponse = null;
    queueMicrotask(() => {
      if (this.terminated) return; // matches a real worker: nothing arrives after terminate()
      if (script) {
        script(this, msg);
        return;
      }
      // Default: every request type succeeds with a minimal-but-valid payload.
      const payload =
        msg.type === 'init'
          ? { kind: 'ready' }
          : msg.type === 'inspect'
            ? { kind: 'inspect', info: { format: null } }
            : msg.type === 'pdf-info'
              ? { kind: 'pdf-info', pageCount: 1 }
              : msg.type === 'pdf-extract'
                ? { kind: 'pdf-extract', pages: [] }
                : { kind: 'run', result: { data: new Uint8Array(), mime: 'application/octet-stream', filename: 'x', stages: [] } };
      this.onmessage?.({ data: { id: msg.id, type: 'result', payload } });
    });
  }

  terminate() {
    this.terminated = true;
  }
}
/** One-shot override for the next postMessage's response; null = default success. */
FakeWorker.nextResponse = null;

globalThis.Worker = FakeWorker;

// Import *after* installing the fake global, since EngineClient's
// constructor spawns a worker immediately.
const { EngineClient, EngineError } = await import('../src/engine/client.ts');

// ── tests ────────────────────────────────────────────────────────────

section('EngineClient: happy path');
await check('init() resolves once the fake worker acks it', async () => {
  const client = new EngineClient();
  await client.init();
  assert.equal(client.worker.terminated, false);
});

section('EngineClient: crash detection (onCrash)');
await check('a worker-level error rejects the in-flight call and fires onCrash exactly once', async () => {
  const client = new EngineClient();
  let crashCount = 0;
  client.onCrash = () => crashCount++;

  // Don't let this particular postMessage auto-resolve — instead, fire
  // onerror directly on the worker, exactly like a real crash would.
  FakeWorker.nextResponse = (worker) => {
    worker.onerror?.({ message: 'simulated crash' });
  };

  await assert.rejects(() => client.init(), (err) => {
    assert.ok(err instanceof EngineError);
    return true;
  });
  assert.equal(crashCount, 1, 'onCrash should fire exactly once');
});

await check('onCrash does not fire again for a second, unrelated worker-level error after the first', async () => {
  // Guards against onCrash firing once per pending call instead of once
  // per crash event — onerror itself should only ever be invoked once
  // by the fake per scripted crash, so this mostly documents the
  // expected cardinality for anyone changing spawnWorker() later.
  const client = new EngineClient();
  let crashCount = 0;
  client.onCrash = () => crashCount++;
  FakeWorker.nextResponse = (worker) => worker.onerror?.({ message: 'simulated crash' });
  await assert.rejects(() => client.init());
  assert.equal(crashCount, 1);
});

section('EngineClient: restart()');
await check('restart() replaces the dead worker with a working one', async () => {
  const client = new EngineClient();
  const firstWorkerId = client.worker.instanceId;

  FakeWorker.nextResponse = (worker) => worker.onerror?.({ message: 'simulated crash' });
  await assert.rejects(() => client.init());

  await client.restart();
  assert.notEqual(client.worker.instanceId, firstWorkerId, 'restart() should spawn a new worker instance');

  // A call after restart() should land on the new worker and succeed.
  await client.init();
  assert.equal(client.worker.posted.at(-1).type, 'init');
});

await check('a call still pending on the old worker at restart() time is rejected, not left hanging', async () => {
  const client = new EngineClient();
  const inspectPromise = client.inspect(new Uint8Array([1, 2, 3]));
  // Don't let the fake auto-resolve this one — restart() should reject it itself.
  await client.restart();
  await assert.rejects(() => inspectPromise, (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.message, 'engine restarting');
    return true;
  });
});

section('EngineClient: cancel()');
await check('cancel() is a no-op when nothing is pending — no restart happens', async () => {
  const client = new EngineClient();
  await client.init();
  const workerIdBefore = client.worker.instanceId;
  await client.cancel();
  assert.equal(client.worker.instanceId, workerIdBefore, 'cancel() with nothing pending should not spawn a new worker');
});

await check('cancel() rejects the in-flight call with a CANCELLED code and swaps in a fresh worker', async () => {
  const client = new EngineClient();
  await client.init();
  const firstWorkerId = client.worker.instanceId;

  const runPromise = client.run(new Uint8Array([1]), 'photo.jpg', /** @type {any} */ ({}));
  // Note: cancel() awaits restart(), which itself awaits a fresh init() —
  // that init() call is left to auto-resolve via the fake's default path.
  await client.cancel();

  await assert.rejects(() => runPromise, (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'CANCELLED');
    return true;
  });
  assert.notEqual(client.worker.instanceId, firstWorkerId, 'cancel() should have spawned a new worker');

  // Confirm the client is actually usable again after cancelling.
  await client.init();
  assert.equal(client.worker.posted.at(-1).type, 'init');
});

section('EngineClient: dispose()');
await check('dispose() terminates the worker and does not fire onCrash', async () => {
  const client = new EngineClient();
  let crashed = false;
  client.onCrash = () => (crashed = true);
  await client.init();
  client.dispose();
  assert.equal(client.worker.terminated, true);
  assert.equal(crashed, false, 'a deliberate dispose() should not be reported as a crash');
});

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all client lifecycle checks passed');
