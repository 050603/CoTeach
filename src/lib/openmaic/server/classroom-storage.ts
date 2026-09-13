import { promises as fs } from 'fs';
import path from 'path';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';

export function resolveClassroomsDir(
  environment: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment.CLASSROOM_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(cwd, 'data', 'classrooms');
}

export const CLASSROOMS_DIR = resolveClassroomsDir();

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

/** Serialize read-modify-write updates for one classroom snapshot. */
const classroomLocks = new Map<string, Promise<void>>();

async function withClassroomLock<T>(classroomId: string, fn: () => Promise<T>): Promise<T> {
  const previous = classroomLocks.get(classroomId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  classroomLocks.set(classroomId, current);

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (classroomLocks.get(classroomId) === current) {
      classroomLocks.delete(classroomId);
    }
  }
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
  /** Monotonic document revision used by teacher editing to reject stale saves. */
  revision?: number;
  /** Last content or asset update. Legacy snapshots may not have this field. */
  updatedAt?: string;
  assetGeneration?: ClassroomAssetGenerationStatus;
}

export class ClassroomRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`Classroom revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'ClassroomRevisionConflictError';
  }
}

export type ClassroomAssetGenerationStatus = {
  status: 'running' | 'completed' | 'partial-failure';
  requested: number;
  completed: number;
  failures: Array<{ elementId: string; type: 'image' | 'video' | 'tts'; error: string }>;
  updatedAt: string;
};

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

const CLASSROOM_MEDIA_ROUTE = '/api/openmaic/classroom-media/';

/** Convert legacy absolute asset URLs to the same-origin form on every read. */
export function normalizeClassroomAssetUrls<T>(value: T): T {
  if (typeof value === 'string') {
    const routeIndex = value.indexOf(CLASSROOM_MEDIA_ROUTE);
    return (routeIndex >= 0 ? value.slice(routeIndex) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeClassroomAssetUrls(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeClassroomAssetUrls(item),
      ]),
    ) as T;
  }
  return value;
}

export function normalizePersistedClassroom(data: PersistedClassroomData): PersistedClassroomData {
  const normalized = normalizeClassroomAssetUrls(data);
  return {
    ...normalized,
    scenes: normalized.scenes.map((scene) => ({
      ...scene,
      actions: removeLegacySyntheticWhiteboardActions(scene.actions ?? []),
      ...(scene.audience === 'student'
        && scene.stageKey === 'ai-learning'
        && scene.generationPurpose === 'knowledge-teaching'
        ? { ttsPolicy: 'target-duration' as const }
        : {}),
    })),
  };
}

const BOARD_DRAW_TYPES = new Set<Action['type']>([
  'wb_draw_text',
  'wb_draw_image',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
]);

/** Remove the old key-point-list fallback and only the shells emptied by it. */
export function removeLegacySyntheticWhiteboardActions(
  actions: ReadonlyArray<Action>,
): Action[] {
  const withoutSyntheticNotes: Action[] = [];
  const emptyLifecycleIndexes = new Set<number>();
  let openIndex = -1;
  let hasDrawing = false;
  let removedSyntheticNote = false;

  actions.forEach((action) => {
    if (action.type === 'wb_draw_text' && action.elementId?.startsWith('planned-note-')) {
      if (openIndex >= 0) removedSyntheticNote = true;
      return;
    }
    const index = withoutSyntheticNotes.length;
    withoutSyntheticNotes.push(action);
    if (action.type === 'wb_open') {
      if (openIndex >= 0 && !hasDrawing && removedSyntheticNote) emptyLifecycleIndexes.add(openIndex);
      openIndex = index;
      hasDrawing = false;
      removedSyntheticNote = false;
      return;
    }
    if (openIndex >= 0 && BOARD_DRAW_TYPES.has(action.type)) hasDrawing = true;
    if (action.type === 'wb_close' && openIndex >= 0) {
      if (!hasDrawing && removedSyntheticNote) {
        emptyLifecycleIndexes.add(openIndex);
        emptyLifecycleIndexes.add(index);
      }
      openIndex = -1;
      hasDrawing = false;
      removedSyntheticNote = false;
    }
  });
  if (openIndex >= 0 && !hasDrawing && removedSyntheticNote) emptyLifecycleIndexes.add(openIndex);
  return withoutSyntheticNotes
    .filter((_action, index) => !emptyLifecycleIndexes.has(index))
    .map((action) => ({ ...action }));
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return normalizePersistedClassroom(JSON.parse(content) as PersistedClassroomData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
): Promise<PersistedClassroomData> {
  return withClassroomLock(data.id, async () => {
    const now = new Date().toISOString();
    const next: PersistedClassroomData = {
      id: data.id,
      stage: data.stage,
      scenes: data.scenes,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };

    await ensureClassroomsDir();
    const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
    await writeJsonFileAtomic(filePath, next);
    return next;
  });
}

/**
 * Atomically replace only the scene payload of an already persisted classroom.
 * This is used by background media/TTS tasks so completed assets are visible
 * without rewriting the stage metadata or the original creation timestamp.
 */
export async function updatePersistedClassroomScenes(
  classroomId: string,
  scenes: Scene[],
): Promise<PersistedClassroomData> {
  return withClassroomLock(classroomId, async () => {
    const existing = await readClassroom(classroomId);
    if (!existing) {
      throw new Error(`Classroom not found while updating scenes: ${classroomId}`);
    }

    const updated: PersistedClassroomData = {
      ...existing,
      scenes,
      revision: (existing.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const filePath = path.join(CLASSROOMS_DIR, `${classroomId}.json`);
    await writeJsonFileAtomic(filePath, updated);
    return updated;
  });
}

export async function updatePersistedClassroomAssetStatus(
  classroomId: string,
  assetGeneration: ClassroomAssetGenerationStatus,
): Promise<PersistedClassroomData> {
  return withClassroomLock(classroomId, async () => {
    const existing = await readClassroom(classroomId);
    if (!existing) throw new Error(`Classroom not found while updating asset status: ${classroomId}`);
    const updated = {
      ...existing,
      assetGeneration,
      revision: (existing.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(path.join(CLASSROOMS_DIR, `${classroomId}.json`), updated);
    return updated;
  });
}

/**
 * Replace a teacher-editable classroom document with optimistic concurrency.
 * Generated media can update the same JSON file in the background, so the
 * revision covers both content and asset writes rather than only canvas edits.
 */
export async function updatePersistedClassroomForEditing(
  classroomId: string,
  data: { stage: Stage; scenes: Scene[] },
  expectedRevision: number,
): Promise<PersistedClassroomData> {
  return withClassroomLock(classroomId, async () => {
    const existing = await readClassroom(classroomId);
    if (!existing) throw new Error(`Classroom not found while saving edit: ${classroomId}`);
    const actualRevision = existing.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new ClassroomRevisionConflictError(expectedRevision, actualRevision);
    }
    const updated: PersistedClassroomData = {
      ...existing,
      stage: data.stage,
      scenes: data.scenes,
      revision: actualRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(path.join(CLASSROOMS_DIR, `${classroomId}.json`), updated);
    return updated;
  });
}

/** Copy the generated media directory when a published classroom becomes a new draft. */
export async function copyClassroomMedia(sourceId: string, targetId: string): Promise<void> {
  if (!isValidClassroomId(sourceId) || !isValidClassroomId(targetId)) {
    throw new Error('Invalid classroom id while copying media');
  }
  const sourceDir = path.join(CLASSROOMS_DIR, sourceId);
  const targetDir = path.join(CLASSROOMS_DIR, targetId);
  try {
    await fs.cp(sourceDir, targetDir, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
