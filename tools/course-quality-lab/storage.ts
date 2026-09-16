import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  CourseQualityLabManifest,
  PairReview,
  ReviewCollection,
} from "./types";

export const DEFAULT_LAB_ROOT = path.resolve(
  process.cwd(),
  ".openpbl-runtime/course-quality-lab",
);

export class LabStorageError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_JSON" | "INVALID_DATA",
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "LabStorageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidPairReview(value: unknown): value is PairReview {
  if (!isRecord(value)) return false;
  if (typeof value.pairId !== "string" || !value.pairId) return false;
  if (!["baseline", "enhanced", "tie", "undecided"].includes(String(value.outcome))) return false;
  if (!isRecord(value.dimensions) || !isRecord(value.pageNotes)) return false;
  return true;
}

function parseReviewCollection(value: unknown, filePath: string): ReviewCollection {
  if (!isRecord(value) || !Array.isArray(value.reviews) || !value.reviews.every(isValidPairReview)) {
    throw new LabStorageError("INVALID_DATA", "reviews.json 的数据格式无效。", filePath);
  }
  return { reviews: value.reviews };
}

async function readJson(filePath: string, required: boolean): Promise<unknown | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!required) return undefined;
      throw new LabStorageError("NOT_FOUND", `${path.basename(filePath)} 尚未生成。`, filePath);
    }
    throw error;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new LabStorageError("INVALID_JSON", `${path.basename(filePath)} 不是有效的 JSON。`, filePath);
  }
}

/**
 * Replace one JSON file without exposing a partially-written document. The
 * temporary file is kept in the destination directory so rename is atomic.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tempPath, filePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export class CourseQualityLabStorage {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly reviewsPath: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(rootDir = DEFAULT_LAB_ROOT) {
    this.rootDir = path.resolve(rootDir);
    this.manifestPath = path.join(this.rootDir, "manifest.json");
    this.reviewsPath = path.join(this.rootDir, "reviews.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async readManifest(): Promise<CourseQualityLabManifest> {
    const value = await readJson(this.manifestPath, true);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sections)) {
      throw new LabStorageError("INVALID_DATA", "manifest.json 的数据格式无效。", this.manifestPath);
    }
    return value as unknown as CourseQualityLabManifest;
  }

  async readReviews(): Promise<ReviewCollection> {
    const value = await readJson(this.reviewsPath, false);
    return value === undefined ? { reviews: [] } : parseReviewCollection(value, this.reviewsPath);
  }

  /** Serializes saves so two rapid autosaves cannot overwrite one another. */
  async savePairReview(review: PairReview): Promise<ReviewCollection> {
    let saved: ReviewCollection | undefined;
    const save = async () => {
      const current = await this.readReviews();
      const reviews = current.reviews.filter((item) => item.pairId !== review.pairId);
      reviews.push(review);
      saved = { reviews };
      await writeJsonAtomic(this.reviewsPath, saved);
    };
    const pending = this.saveQueue.then(save, save);
    this.saveQueue = pending.then(() => undefined, () => undefined);
    await pending;
    return saved as ReviewCollection;
  }
}

