import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db/client';
import {
  recoverDerivedPreview,
  inspectDerivedPreview,
  sha256File,
} from '../src/lib/uploads/derived-recovery';

type Options = {
  dryRun: boolean;
  backfillHashes: boolean;
  manifestDir?: string;
  classroomIds: string[];
};

function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, backfillHashes: false, classroomIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--backfill-hashes') options.backfillHashes = true;
    else if (argument === '--manifest') options.manifestDir = path.resolve(argv[++index] ?? '');
    else if (argument === '--classroom') options.classroomIds.push(argv[++index] ?? '');
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.classroomIds.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error('Every --classroom value must be a safe classroom id');
  }
  if (!options.dryRun && !options.backfillHashes && !options.manifestDir && options.classroomIds.length === 0) {
    throw new Error('A restore manifest or explicit --classroom is required before regeneration');
  }
  return options;
}

async function readQueue(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return content.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const id = trimmed.split('\t', 1)[0];
    return id ? [id] : [];
  });
}

async function discoverClassroomIds(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.flatMap((entry) => {
    const match = /^([a-zA-Z0-9_-]+)\.json$/.exec(entry.name);
    return entry.isFile() && match ? [match[1]] : [];
  });
}

async function recoverClassroom(classroomId: string, rootDir: string, dryRun: boolean) {
  const [storage, recovery, media] = await Promise.all([
    import('../src/lib/openmaic/server/classroom-storage'),
    import('../src/lib/openmaic/server/classroom-asset-recovery'),
    import('../src/lib/openmaic/server/classroom-media-generation'),
  ]);
  const classroom = await storage.readClassroom(classroomId);
  if (!classroom) throw new Error(`Classroom script is missing: ${classroomId}.json`);
  const plan = await recovery.planClassroomTtsRecovery(classroom, rootDir);
  if (plan.unrecoverableActionIds.length > 0) {
    throw new Error(`Classroom ${classroomId} has audio without restorable text: ${plan.unrecoverableActionIds.join(', ')}`);
  }
  if (plan.missingActionIds.length === 0) {
    console.log(`tts ${classroomId}: ready`);
    return;
  }
  if (dryRun) {
    console.log(`tts ${classroomId}: would-regenerate=${plan.missingActionIds.length}`);
    return;
  }

  console.log(`tts ${classroomId}: regenerating=${plan.missingActionIds.length}`);
  let generationError: unknown;
  try {
    await media.generateTTSForClassroom(
      plan.classroom.scenes,
      classroomId,
      process.env.PUBLIC_BASE_URL?.trim() || '',
      undefined,
      recovery.classroomTtsTimingOptions(plan.classroom.scenes),
    );
  } catch (error) {
    generationError = error;
  }
  // Successful segments are checkpointed even when a provider fails later;
  // rerunning the command then pays only for the remaining clips.
  await storage.updatePersistedClassroomScenes(classroomId, plan.classroom.scenes);
  if (generationError) throw generationError;
  const remaining = await recovery.planClassroomTtsRecovery(plan.classroom, rootDir);
  if (remaining.missingActionIds.length > 0) {
    throw new Error(`TTS provider produced no durable audio for classroom ${classroomId}`);
  }
  console.log(`tts ${classroomId}: restored=${plan.missingActionIds.length}`);
}

async function recoverUploadPreviews(
  ids: string[] | undefined,
  rootDir: string,
  dryRun: boolean,
  lifecycleSchemaAvailable: boolean,
) {
  if (!lifecycleSchemaAvailable) {
    console.log('uploads: legacy schema keeps all preview bytes; nothing to rehydrate');
    return;
  }
  const records = await prisma.fileAsset.findMany({
      where: {
        backupPolicy: 'REGENERATE',
        deletedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      select: {
        id: true,
        storageKey: true,
        sha256: true,
        backupPolicy: true,
        regenerationRecipe: true,
        sourceAsset: { select: { storageKey: true } },
      },
    });
  for (const record of records) {
    const state = await inspectDerivedPreview(record, rootDir);
    if (dryRun || state === 'present') {
      console.log(`upload ${record.id}: ${dryRun && state !== 'present' ? `would-recover-${state}` : state}`);
      continue;
    }
    if (state === 'source-missing' || state === 'unsupported') {
      throw new Error(`Derived upload ${record.id} cannot be recovered: ${state}`);
    }
    const result = await recoverDerivedPreview(record, rootDir);
    if (!result.size || !result.sha256) throw new Error(`Derived upload ${record.id} was not regenerated`);
    await prisma.fileAsset.update({
      where: { id: record.id },
      data: { size: BigInt(result.size), sha256: result.sha256, mimeType: 'application/pdf' },
    });
    console.log(`upload ${record.id}: restored=${result.size}B`);
  }
}

async function assetLifecycleSchemaAvailable(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ available: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'FileAsset'
        AND column_name = 'backupPolicy'
    ) AS available
  `;
  return rows[0]?.available ?? false;
}

async function auditRequiredUploads(
  rootDir: string,
  lifecycleSchemaAvailable: boolean,
  backfillHashes: boolean,
) {
  let records: Array<{ id: string; storageKey: string; sha256: string | null }>;
  if (lifecycleSchemaAvailable) {
    records = await prisma.fileAsset.findMany({
      where: { backupPolicy: 'REQUIRED', deletedAt: null },
      select: { id: true, storageKey: true, sha256: true },
    });
  } else {
    records = await prisma.fileAsset.findMany({
      where: { deletedAt: null },
      select: { id: true, storageKey: true, sha256: true },
    });
  }
  const failures: string[] = [];
  let hashVerified = 0;
  let hashBackfilled = 0;
  for (const record of records) {
    if (path.basename(record.storageKey) !== record.storageKey) {
      failures.push(`${record.id}: unsafe storage key`);
      continue;
    }
    const filePath = path.join(rootDir, record.storageKey);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      failures.push(`${record.id}: required file missing`);
      continue;
    }
    if (record.sha256) {
      hashVerified += 1;
      if (await sha256File(filePath) !== record.sha256) failures.push(`${record.id}: sha256 mismatch`);
    } else if (backfillHashes) {
      const sha256 = await sha256File(filePath);
      await prisma.fileAsset.update({ where: { id: record.id }, data: { sha256 } });
      hashBackfilled += 1;
    }
  }
  console.log(`uploads: required=${records.length} sha256-verified=${hashVerified} sha256-backfilled=${hashBackfilled}`);
  if (failures.length > 0) throw new Error(failures.join(', '));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const classroomRoot = path.resolve(process.env.CLASSROOM_DATA_DIR?.trim() || 'data/classrooms');
  const uploadRoot = path.resolve(process.env.UPLOAD_DIR?.trim() || '.openpbl-data/uploads');
  const queuedClassrooms = options.manifestDir
    ? await readQueue(path.join(options.manifestDir, 'classroom-tts.tsv'))
    : options.dryRun && options.classroomIds.length === 0
      ? await discoverClassroomIds(classroomRoot)
      : [];
  const classroomIds = [...new Set([...options.classroomIds, ...queuedClassrooms])];
  const queuedUploads = options.manifestDir
    ? await readQueue(path.join(options.manifestDir, 'derived-uploads.tsv'))
    : options.dryRun ? undefined : [];

  const failures: string[] = [];
  const lifecycleSchema = await assetLifecycleSchemaAvailable();
  try {
    await auditRequiredUploads(uploadRoot, lifecycleSchema, options.backfillHashes && !options.dryRun);
  } catch (error) {
    failures.push(`required uploads: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const classroomId of classroomIds) {
    try {
      await recoverClassroom(classroomId, classroomRoot, options.dryRun);
    } catch (error) {
      failures.push(`tts ${classroomId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await recoverUploadPreviews(queuedUploads, uploadRoot, options.dryRun, lifecycleSchema);
  } catch (error) {
    failures.push(`uploads: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect().catch(() => undefined));
