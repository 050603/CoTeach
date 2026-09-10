import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 8_000;

export type PresentationConversionErrorCode =
  | "CONVERTER_UNAVAILABLE"
  | "CONVERSION_FAILED"
  | "CONVERSION_TIMEOUT"
  | "INVALID_PDF_OUTPUT";

export class PresentationConversionError extends Error {
  constructor(
    readonly code: PresentationConversionErrorCode,
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "PresentationConversionError";
  }
}

export type PresentationConversionResult = {
  size: number;
  mimeType: "application/pdf";
};

/**
 * Convert a presentation into a fixed-layout classroom PDF.
 *
 * LibreOffice receives an isolated user profile for every conversion so
 * concurrent uploads cannot share locks or configuration. The caller owns
 * the source file; this function creates only `targetPath` and removes any
 * partial target when conversion fails.
 */
export async function convertPresentationToPdf({
  sourcePath,
  targetPath,
}: {
  sourcePath: string;
  targetPath: string;
}): Promise<PresentationConversionResult> {
  const workDir = await mkdtemp(path.join(tmpdir(), "openpbl-presentation-"));
  const profileDir = path.join(workDir, "profile");
  const outputDir = path.join(workDir, "output");
  const generatedPath = path.join(outputDir, `${path.parse(sourcePath).name}.pdf`);
  const converter = process.env.OPENPBL_PRESENTATION_CONVERTER_BIN?.trim() || "libreoffice";
  const timeoutMs = readBoundedInteger(
    process.env.OPENPBL_PRESENTATION_CONVERSION_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    10_000,
    5 * 60_000,
  );
  const maxPreviewBytes = readBoundedInteger(
    process.env.OPENPBL_PRESENTATION_PREVIEW_MAX_BYTES,
    DEFAULT_MAX_PREVIEW_BYTES,
    1024 * 1024,
    200 * 1024 * 1024,
  );

  try {
    await mkdir(profileDir, { mode: 0o700 });
    await mkdir(outputDir, { mode: 0o700 });
    const diagnostic = await runConverter({
      converter,
      sourcePath,
      outputDir,
      profileDir,
      timeoutMs,
    });

    const info = await stat(generatedPath).catch(() => null);
    if (!info?.isFile() || info.size <= 0 || info.size > maxPreviewBytes) {
      throw new PresentationConversionError(
        "INVALID_PDF_OUTPUT",
        "转换器没有生成有效的 PDF 课堂版。",
        diagnostic,
      );
    }
    if (!(await hasPdfSignature(generatedPath))) {
      throw new PresentationConversionError(
        "INVALID_PDF_OUTPUT",
        "转换结果不是有效的 PDF 文件。",
        diagnostic,
      );
    }

    await copyFile(generatedPath, targetPath, constants.COPYFILE_EXCL);
    await chmod(targetPath, 0o644);
    return { size: info.size, mimeType: "application/pdf" };
  } catch (error) {
    await unlink(targetPath).catch(() => undefined);
    if (error instanceof PresentationConversionError) throw error;
    throw new PresentationConversionError(
      "CONVERSION_FAILED",
      "PPT 转换服务执行失败。",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runConverter({
  converter,
  sourcePath,
  outputDir,
  profileDir,
  timeoutMs,
}: {
  converter: string;
  sourcePath: string;
  outputDir: string;
  profileDir: string;
  timeoutMs: number;
}): Promise<string> {
  const args = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--nolockcheck",
    "--norestore",
    "--convert-to",
    "pdf:impress_pdf_Export",
    "--outdir",
    outputDir,
    sourcePath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(converter, args, {
      env: { ...process.env, SAL_USE_VCLPLUGIN: "svp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;

    const appendOutput = (chunk: Buffer | string) => {
      if (output.length >= MAX_DIAGNOSTIC_CHARS) return;
      output += chunk.toString().slice(0, MAX_DIAGNOSTIC_CHARS - output.length);
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new PresentationConversionError(
        error.code === "ENOENT" ? "CONVERTER_UNAVAILABLE" : "CONVERSION_FAILED",
        error.code === "ENOENT"
          ? "服务器未安装 PPT 转换器。"
          : "PPT 转换器无法启动。",
        error.message,
      ));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new PresentationConversionError(
          "CONVERSION_TIMEOUT",
          "PPT 转换超时。",
          output,
        ));
        return;
      }
      if (code !== 0) {
        reject(new PresentationConversionError(
          "CONVERSION_FAILED",
          "PPT 转换器返回失败状态。",
          `${output}\nexit=${code ?? "null"} signal=${signal ?? "none"}`.trim(),
        ));
        return;
      }
      resolve(output.trim());
    });
  });
}

async function hasPdfSignature(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === signature.length && signature.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
