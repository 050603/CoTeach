import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DocumentConversionBusyError } from "./document-conversion-queue";
import type { DocumentConversionInput, DocumentConversionOutput } from "./document-conversion-engine";

const SIZE = 2, MAX_WAITING = 64, WAIT_MS = 10_000, START_MS = 15_000, EXECUTION_MS = 30_000;
type Job = { id: string; input: DocumentConversionInput; deadline: number; timer: ReturnType<typeof setTimeout>; resolve: (output: DocumentConversionOutput) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; ready: boolean; failed: boolean; job?: Job; execution?: ReturnType<typeof setTimeout>; startup: ReturnType<typeof setTimeout> };
type Pool = { slots: Slot[]; waiting: Job[]; initialization?: Promise<void>; resolveStart?: () => void; rejectStart?: (error: Error) => void; initialized: boolean; stopping: boolean; failed: boolean; restarts: number[]; error?: string; shutdown?: Promise<void> };
declare global { var __openPblDocumentConversionPool: Pool | undefined; }
const pool = globalThis.__openPblDocumentConversionPool ??= { slots: [], waiting: [], initialized: false, stopping: false, failed: false, restarts: [] };
function unavailable() { return Object.assign(new Error("Word 归档引擎暂不可用，请稍后重试。"), { code: "DOCUMENT_CONVERSION_UNAVAILABLE" }); }
function rejectWaiting(error: Error) { for (const job of pool.waiting.splice(0)) { clearTimeout(job.timer); job.reject(error); } }
function dispatch() {
  if (pool.stopping || pool.failed) return;
  for (const slot of pool.slots) {
    if (!slot.ready || slot.failed || slot.job) continue;
    for (let job = pool.waiting.shift(); job; job = pool.waiting.shift()) {
      clearTimeout(job.timer);
      if (performance.now() >= job.deadline) { job.reject(new DocumentConversionBusyError()); continue; }
      slot.job = job; slot.worker.ref();
      slot.execution = setTimeout(() => fail(slot, "WORKER_EXECUTION_TIMEOUT"), EXECUTION_MS);
      try { slot.worker.postMessage({ type: "convert", id: job.id, input: job.input }); }
      catch { fail(slot, "WORKER_SEND_FAILED"); }
      break;
    }
  }
}
function fail(slot: Slot, reason: string) {
  if (slot.failed) return;
  slot.failed = true; slot.ready = false; clearTimeout(slot.startup); clearTimeout(slot.execution); pool.error = reason;
  if (!pool.initialized) {
    pool.failed = true; pool.rejectStart?.(unavailable()); rejectWaiting(unavailable());
    for (const entry of pool.slots) { clearTimeout(entry.startup); void entry.worker.terminate().catch(() => undefined); }
    return;
  }
  const job = slot.job;
  // Ignore all late messages once failed, but do not release/reject an active
  // job until Node confirms termination. Pure conversion cannot commit files.
  void slot.worker.terminate().catch(() => {
    // A rejected termination is not proof the old thread stopped. Do not
    // release its slot or spawn additional threads; readiness stays failed.
    pool.failed = true; pool.error = "WORKER_TERMINATION_FAILED";
    rejectWaiting(unavailable()); job?.reject(unavailable()); return false;
  }).then(terminated => {
    if (terminated === false) return;
    slot.job = undefined; job?.reject(unavailable());
    if (pool.stopping || pool.failed) return;
    const now = performance.now(); pool.restarts = pool.restarts.filter(at => now - at < 60_000);
    if (pool.restarts.length >= 3) { pool.failed = true; rejectWaiting(unavailable()); return; }
    pool.restarts.push(now);
    spawn(pool.slots.indexOf(slot)); dispatch();
  });
  dispatch();
}

function spawn(index: number) {
  if (pool.stopping || pool.failed) return;
  // standalone/server.js changes cwd to its immutable release directory.
  // Never fall back to source TypeScript, a loader, or the mutable worktree.
  let worker: Worker;
  try { worker = new Worker(path.join(process.cwd(), "workers", "docx-converter.cjs"), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 }, env: { NODE_ENV: "production", TZ: process.env.TZ || "UTC" } }); }
  catch { pool.failed = true; pool.error = "WORKER_START_FAILED"; pool.rejectStart?.(unavailable()); rejectWaiting(unavailable()); for (const entry of pool.slots) { clearTimeout(entry.startup); void entry.worker.terminate().catch(() => undefined); } return; }
  const slot: Slot = { worker, ready: false, failed: false, startup: setTimeout(() => fail(slot, "WORKER_START_TIMEOUT"), START_MS) };
  pool.slots[index] = slot;
  worker.on("error", () => fail(slot, "WORKER_ERROR"));
  worker.on("exit", () => fail(slot, "WORKER_EXIT"));
  worker.on("message", (message: { type?: string; protocol?: number; id?: string; bytes?: Uint8Array; sha256?: string; code?: string; message?: string; error?: string }) => {
    if (slot.failed) return;
    if (message.type === "fatal") { fail(slot, message.error === "WORKER_WARMUP_FAILED" ? message.error : "WORKER_PROTOCOL_ERROR"); return; }
    if (message.type === "ready" && message.protocol === 1 && !slot.ready) {
      clearTimeout(slot.startup); slot.ready = true; worker.unref();
      if (pool.slots.filter(entry => entry.ready && !entry.failed).length === SIZE) {
        pool.initialized = true; pool.error = undefined; pool.resolveStart?.();
      }
      dispatch(); return;
    }
    const job = slot.job;
    if (!job || message.id !== job.id) { fail(slot, "WORKER_PROTOCOL_ERROR"); return; }
    if (message.type === "result" && message.bytes instanceof Uint8Array && typeof message.sha256 === "string" && /^[a-f0-9]{64}$/.test(message.sha256)) {
      clearTimeout(slot.execution); slot.job = undefined; worker.unref(); job.resolve({ bytes: message.bytes, sha256: message.sha256 });
    } else if (message.type === "error" && ["DOCX_INVALID", "DOCX_CONVERSION_FAILED"].includes(message.code ?? "")) {
      clearTimeout(slot.execution); slot.job = undefined; worker.unref(); job.reject(Object.assign(new Error(message.message || "Word 文件生成失败，请稍后重试。"), { code: message.code }));
    } else { fail(slot, "WORKER_PROTOCOL_ERROR"); return; }
    dispatch();
  });
}
export function initializeDocumentConversionPool(): Promise<void> {
  if (pool.stopping || pool.failed) return Promise.reject(unavailable());
  pool.initialization ??= new Promise<void>((resolve, reject) => { pool.resolveStart = resolve; pool.rejectStart = reject; for (let index = 0; index < SIZE; index++) spawn(index); });
  return pool.initialization;
}
export async function convertDocumentInWorker(input: DocumentConversionInput): Promise<DocumentConversionOutput> {
  await initializeDocumentConversionPool();
  if (pool.stopping || pool.failed || !pool.slots.some(slot => slot.ready && !slot.failed)) throw unavailable();
  if (pool.waiting.length >= MAX_WAITING) throw new DocumentConversionBusyError();
  return new Promise<DocumentConversionOutput>((resolve, reject) => {
    const job: Job = { id: randomUUID(), input, deadline: performance.now() + WAIT_MS, resolve, reject,
      timer: setTimeout(() => { const index = pool.waiting.indexOf(job); if (index !== -1) { pool.waiting.splice(index, 1); reject(new DocumentConversionBusyError()); } }, WAIT_MS),
    };
    pool.waiting.push(job); dispatch();
  });
}
export function documentConversionHealth() {
  const ready = pool.slots.filter(slot => slot.ready && !slot.failed).length;
  return { ok: pool.initialized && !pool.failed && !pool.stopping && ready === SIZE, ready, target: SIZE, busy: pool.slots.filter(slot => slot.job).length, queued: pool.waiting.length, ...(pool.error ? { error: pool.error } : {}) };
}
export function stopDocumentConversionPool(): Promise<void> {
  pool.shutdown ??= (async () => {
    pool.stopping = true; rejectWaiting(unavailable());
    // Let accepted pure conversions finish, then close idle workers. The caller's
    // shutdown ceiling can still terminate the process; never resolve false success.
    while (pool.slots.some(slot => slot.job)) await new Promise(resolve => setTimeout(resolve, 10));
    await Promise.all(pool.slots.map(slot => { clearTimeout(slot.startup); return slot.worker.terminate(); }));
  })();
  return pool.shutdown;
}
