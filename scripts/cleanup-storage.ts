import { prisma } from '../src/lib/db/client';
import { cleanupExpiredFiles, cleanupOrphanFiles, type CleanupResult } from '../src/lib/uploads/cleanup';
import { cleanupClassroomStorage, type ClassroomCleanupResult } from '../src/lib/openmaic/server/classroom-cleanup';

const classroomDir = process.env.CLASSROOM_DATA_DIR?.trim();
if (!classroomDir) throw new Error('CLASSROOM_DATA_DIR is required');

function uploadSummary(label: string, result: CleanupResult) {
  console.log(`${label}: deleted=${result.deleted.length} failed=${result.failed.length}`);
  result.deleted.forEach((item) => console.log(`  deleted ${item}`));
  result.failed.forEach((item) => console.error(`  failed ${item}`));
}

function classroomSummary(result: ClassroomCleanupResult) {
  console.log(`classrooms: deleted=${result.deleted.length} bytes=${result.deletedBytes} failed=${result.failed.length} missing=${result.missingReferences.length}`);
  result.deleted.forEach((item) => console.log(`  deleted ${item}`));
  result.failed.forEach((item) => console.error(`  failed ${item}`));
  result.missingReferences.forEach((item) => console.error(`  missing ${item}`));
}

async function main() {
  await prisma.$connect();
  const [versions, offerings, activeJobs] = await Promise.all([
    prisma.classroomTemplateVersion.findMany({
      where: { OR: [{ template: { status: { not: 'DELETED' } } }, { instances: { some: {} } }] },
      select: { snapshot: true, mediaRefs: true },
    }),
    prisma.courseOffering.findMany({
      where: { archivedAt: null, status: { not: 'DELETED' } },
      select: { coverImageUrl: true },
    }),
    prisma.generationJob.findMany({
      where: { status: { in: ['PENDING', 'QUEUED', 'RUNNING'] } },
      select: { request: true, result: true, trace: true, qualityReport: true },
    }),
  ]);

  uploadSummary('upload-orphans', await cleanupOrphanFiles());
  uploadSummary('upload-tombstones-7d', await cleanupExpiredFiles(7));
  classroomSummary(await cleanupClassroomStorage({
    rootDir: classroomDir,
    durableReferences: [...versions, ...offerings, ...activeJobs],
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect().catch(() => undefined));
