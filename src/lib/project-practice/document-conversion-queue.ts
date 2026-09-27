const MAX_WAITING = 64;
const MAX_WAIT_MS = 10_000;
type ConversionJob = {
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  run: () => Promise<void>;
  rejectBusy: () => void;
};
type ConversionQueue = { active: boolean; scheduled: boolean; waiting: ConversionJob[] };
declare global {
  // Instrumentation and route chunks must use the same process-local limit.
  var __openPblDocumentConversionQueue: ConversionQueue | undefined;
}
const queue = globalThis.__openPblDocumentConversionQueue ??= { active: false, scheduled: false, waiting: [] };
export class DocumentConversionBusyError extends Error {
  readonly code = "DOCUMENT_CONVERSION_BUSY";
  constructor() { super("Word 归档生成繁忙，请保留文档并稍后重试。"); this.name = "DocumentConversionBusyError"; }
}
export function isDocumentConversionBusy(error: unknown): error is Error & { code: string } {
  // Error constructors can differ across Next entry bundles sharing this queue.
  return error instanceof Error && "code" in error && ["DOCUMENT_CONVERSION_BUSY", "DOCUMENT_CONVERSION_UNAVAILABLE"].includes(String(error.code));
}
function drain() {
  if (queue.active || queue.scheduled || !queue.waiting.length) return;
  queue.scheduled = true;
  // Give I/O (including database completions) a turn between conversions.
  setImmediate(() => {
    queue.scheduled = false;
    for (let job = queue.waiting.shift(); job; job = queue.waiting.shift()) {
      clearTimeout(job.timer);
      if (performance.now() >= job.deadline) { job.rejectBusy(); continue; }
      queue.active = true;
      void job.run().finally(() => { queue.active = false; drain(); });
      return;
    }
  });
}
/** Bound waiting work; an active conversion is never falsely cancelled. */
export function runDocumentConversion<T>(operation: () => Promise<T>): Promise<T> {
  if (queue.waiting.length >= MAX_WAITING) return Promise.reject(new DocumentConversionBusyError());
  return new Promise<T>((resolve, reject) => {
    const job: ConversionJob = {
      deadline: performance.now() + MAX_WAIT_MS,
      rejectBusy: () => reject(new DocumentConversionBusyError()),
      timer: setTimeout(() => {
        const index = queue.waiting.indexOf(job);
        if (index === -1) return;
        queue.waiting.splice(index, 1); job.rejectBusy(); drain();
      }, MAX_WAIT_MS),
      run: async () => { try { resolve(await operation()); } catch (error) { reject(error); } },
    };
    queue.waiting.push(job); drain();
  });
}
