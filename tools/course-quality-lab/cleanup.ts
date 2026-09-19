import fs from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./storage";
import type { CourseQualityLabManifest, LabPair, ReviewCollection } from "./types";

const DEFAULT_ROOT = path.resolve(process.env.COURSE_QUALITY_LAB_ROOT ?? ".openpbl-runtime/course-quality-lab");

function pairHasArtifacts(pair: LabPair): boolean {
  return Object.values(pair.variants).some((variant) => variant.slides.length > 0
    || variant.script.length > 0
    || variant.quiz.length > 0
    || Object.values(variant.statuses).every((status) => status.state === "complete"));
}

export interface RemovedLabPair {
  pairId: string;
  experimentId: string;
  sectionId: string;
  batch: number;
}

export function cleanManifestRecords(
  manifest: CourseQualityLabManifest,
  reviews: ReviewCollection,
): { manifest: CourseQualityLabManifest; removed: RemovedLabPair[] } {
  const reviewed = new Set(reviews.reviews.map((review) => review.pairId));
  const next = structuredClone(manifest);
  const removed: RemovedLabPair[] = [];
  for (const section of next.sections) {
    section.pairs = section.pairs.filter((pair) => {
      if (reviewed.has(pair.id) || pairHasArtifacts(pair)) return true;
      removed.push({
        pairId: pair.id,
        experimentId: pair.experimentId ?? pair.id,
        sectionId: section.id,
        batch: pair.batch,
      });
      return false;
    });
  }
  next.generatedAt = new Date().toISOString();
  return { manifest: next, removed };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function acquireCleanupLock(root: string): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, ".generator.lock");
  const create = async () => {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number((await fs.readFile(lockPath, "utf8").catch(() => "")).trim());
    let active = Number.isInteger(pid) && pid > 0;
    if (active) {
      try {
        process.kill(pid, 0);
      } catch {
        active = false;
      }
    }
    if (active) throw new Error(`生成任务仍在运行（PID ${pid}），不能清理实验记录`);
    await fs.unlink(lockPath).catch(() => undefined);
    await create();
  }
  return () => fs.unlink(lockPath).catch(() => undefined);
}

function cleanupTargets(
  root: string,
  removed: readonly RemovedLabPair[],
  retained: readonly RemovedLabPair[],
): string[] {
  const targets = new Set<string>();
  for (const pair of removed) {
    for (const directory of ["runs", "artifacts", "designs"] as const) {
      targets.add(path.join(root, directory, pair.experimentId, pair.sectionId, String(pair.batch)));
    }
    const sameSectionRetained = retained.some((item) => item.experimentId === pair.experimentId
      && item.sectionId === pair.sectionId);
    if (!sameSectionRetained) targets.add(path.join(root, "audio", pair.experimentId, pair.sectionId));
    const sameExperimentRetained = retained.some((item) => item.experimentId === pair.experimentId);
    if (!sameExperimentRetained) {
      targets.add(path.join(root, "experiments", pair.experimentId));
      targets.add(path.join(root, "audio", pair.experimentId));
      targets.add(path.join(root, "reports", `${pair.experimentId}.md`));
      targets.add(path.join(root, "reports", `${pair.experimentId}.json`));
    }
  }
  return [...targets];
}

export async function cleanupLabRuntime(root = DEFAULT_ROOT): Promise<{
  removedPairs: number;
  movedPaths: string[];
  trashDirectory?: string;
}> {
  const release = await acquireCleanupLock(root);
  try {
    const manifestPath = path.join(root, "manifest.json");
    const reviewsPath = path.join(root, "reviews.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CourseQualityLabManifest;
    const reviews = await fs.readFile(reviewsPath, "utf8")
      .then((source) => JSON.parse(source) as ReviewCollection)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { reviews: [] };
        throw error;
      });
    const { manifest: cleaned, removed } = cleanManifestRecords(manifest, reviews);
    if (!removed.length) return { removedPairs: 0, movedPaths: [] };
    const retained = cleaned.sections.flatMap((section) => section.pairs.map((pair) => ({
      pairId: pair.id,
      experimentId: pair.experimentId ?? pair.id,
      sectionId: section.id,
      batch: pair.batch,
    })));
    const stamp = new Date().toISOString().replace(/[^0-9A-Za-z._-]/g, "-");
    const trashDirectory = path.join(root, ".trash", `cleanup-${stamp}`);
    const movedPaths: string[] = [];
    for (const target of cleanupTargets(root, removed, retained)) {
      if (!await exists(target)) continue;
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`拒绝清理实验根目录之外的路径：${target}`);
      }
      const destination = path.join(trashDirectory, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(target, destination);
      movedPaths.push(relative);
    }
    await writeJsonAtomic(manifestPath, cleaned);
    await writeJsonAtomic(path.join(trashDirectory, "removed-pairs.json"), { removed });
    return { removedPairs: removed.length, movedPaths, trashDirectory };
  } finally {
    await release();
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  cleanupLabRuntime().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
