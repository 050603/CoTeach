import { parentPort } from "node:worker_threads";
import { convertDocument, type DocumentConversionInput } from "./document-conversion-engine";

if (!parentPort) throw new Error("Document converter requires a worker thread");
const port = parentPort;
let active = false;
port.on("message", async (message: { type: string; id: string; input: DocumentConversionInput }) => {
  if (message.type !== "convert" || active) {
    port.postMessage({ type: "fatal", error: "WORKER_PROTOCOL_ERROR" }); return;
  }
  active = true;
  try {
    const result = await convertDocument(message.input);
    port.postMessage({ type: "result", id: message.id, ...result }, [result.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    const invalid = error instanceof Error && "code" in error && error.code === "DOCX_INVALID";
    port.postMessage({ type: "error", id: message.id, code: invalid ? "DOCX_INVALID" : "DOCX_CONVERSION_FAILED", message: invalid ? error.message : "Word 文件生成失败，请稍后重试。" });
  } finally { active = false; }
});
// Readiness proves conversion, ZIP/media verification and hashing, not merely import.
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3pWQAAAABJRU5ErkJggg==";
void convertDocument({ html: `<h1>归档预热</h1><img src="${pixel}"><p>完整性检查</p>`, title: "归档预热", imageCount: 1 })
  .then(() => port.postMessage({ type: "ready", protocol: 1 }))
  .catch(() => port.postMessage({ type: "fatal", error: "WORKER_WARMUP_FAILED" }));
