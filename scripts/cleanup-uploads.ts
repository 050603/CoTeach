// CLI entry for upload cleanup (Stage 6).
//
// Usage:
//   pnpm tsx scripts/cleanup-uploads.ts orphans
//       Scan .openpbl-data/uploads/ and delete files with no FileAsset row (after a 24-hour grace period).
//
//   pnpm tsx scripts/cleanup-uploads.ts course <courseId>
//       Remove only explicitly soft-deleted, unreferenced files for an offering; retain database tombstones.
//
//   pnpm tsx scripts/cleanup-uploads.ts expired <days>
//       Remove explicitly soft-deleted files whose tombstones are older
//       than <days> days; active/research assets are retained.

import {
  cleanupCourseFiles,
  cleanupExpiredFiles,
  cleanupOrphanFiles,
  type CleanupResult,
} from "../src/lib/uploads/cleanup";
import { isDatabaseConfigured, prisma } from "../src/lib/db/client";

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  tsx scripts/cleanup-uploads.ts orphans",
      "  tsx scripts/cleanup-uploads.ts course <courseId>",
      "  tsx scripts/cleanup-uploads.ts expired <days>",
    ].join("\n"),
  );
}

function report(label: string, result: CleanupResult): void {
  console.log(`[${label}] deleted=${result.deleted.length} failed=${result.failed.length}`);
  for (const name of result.deleted) console.log(`  ✓ ${name}`);
  for (const name of result.failed) console.log(`  ✗ ${name}`);
}

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set. Export it before running this script.");
    process.exit(1);
  }

  await prisma.$connect();

  let result: CleanupResult;
  switch (subcommand) {
    case "orphans":
      result = await cleanupOrphanFiles();
      report("orphans", result);
      break;
    case "course": {
      const courseId = rest[0];
      if (!courseId) {
        console.error("Missing courseId. Usage: tsx scripts/cleanup-uploads.ts course <courseId>");
        process.exit(1);
      }
      result = await cleanupCourseFiles(courseId);
      report(`course:${courseId}`, result);
      break;
    }
    case "expired": {
      const days = Number(rest[0]);
      if (!Number.isFinite(days) || days <= 0) {
        console.error("Invalid <days>. Usage: tsx scripts/cleanup-uploads.ts expired <days>");
        process.exit(1);
      }
      result = await cleanupExpiredFiles(days);
      report(`expired:${days}d`, result);
      break;
    }
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
