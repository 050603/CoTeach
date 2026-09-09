import type { Prisma } from '@prisma/client';
import type { ProjectPdfVersion, ShowcasePresentationSnapshot, ShowcasePresentationStatus, ShowcaseDisplayMode, ShowcaseViewState } from '@/lib/session/types';
import { createShowcaseStore, showcaseStore as store } from './persistence';
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asShowcaseStatus(value: string): ShowcasePresentationStatus {
  return ["pending", "active", "rejected", "evaluating", "ended", "cancelled"].includes(value)
    ? value as ShowcasePresentationStatus
    : "ended";
}

function asDisplayMode(value: string): ShowcaseDisplayMode {
  return value === "slides" ? "slides" : "continuous";
}

export function rowToSnapshot(
  row: {
    id: string;
    courseId: string;
    groupId: string;
    studentId: string;
    artifactKind: string;
    artifactVersionId: string;
    artifactTitle: string;
    displayMode: string;
    status: string;
    viewState: Prisma.JsonValue | null;
    revision: number;
    rejectionReason: string | null;
    requestedAt: Date;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    evaluationNote?: string | null;
    evaluatedAt?: Date | null;
    evaluatedBy?: string | null;
    updatedAt: Date;
  },
  studentName?: string,
): ShowcasePresentationSnapshot {
  const rawViewState = asRecord(row.viewState);
  const viewState: ShowcaseViewState | undefined = row.viewState
    ? {
        page: typeof rawViewState.page === "number" ? rawViewState.page : undefined,
        scrollRatio: typeof rawViewState.scrollRatio === "number" ? rawViewState.scrollRatio : undefined,
        updatedAt: typeof rawViewState.updatedAt === "string" ? rawViewState.updatedAt : row.updatedAt.toISOString(),
        revision: row.revision,
      }
    : undefined;
  return {
    id: row.id,
    courseId: row.courseId,
    groupId: row.groupId,
    studentId: row.studentId,
    studentName,
    artifactKind: row.artifactKind === "pdf" ? "pdf" : "document",
    artifactVersionId: row.artifactVersionId,
    artifactTitle: row.artifactTitle,
    displayMode: asDisplayMode(row.displayMode),
    status: asShowcaseStatus(row.status),
    revision: row.revision,
    viewState,
    rejectionReason: row.rejectionReason ?? undefined,
    requestedAt: row.requestedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString(),
    reviewedBy: row.reviewedBy ?? undefined,
    startedAt: row.startedAt?.toISOString(),
    endedAt: row.endedAt?.toISOString(),
    evaluationNote: row.evaluationNote ?? undefined,
    evaluatedAt: row.evaluatedAt?.toISOString(),
    evaluatedBy: row.evaluatedBy ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadShowcaseState(instanceId: string, db?: Prisma.TransactionClient): Promise<{
  showcasePresentations: ShowcasePresentationSnapshot[];
  projectPdfVersions: ProjectPdfVersion[];
}> {
  const source = db ? createShowcaseStore(db) : store;
  const [presentations, files] = await Promise.all([
    source.listPresentations({ where: { courseId: instanceId }, orderBy: { updatedAt: 'desc' } }),
    source.listFiles({ where: { courseId: instanceId }, orderBy: { sequence: 'desc' } }),
  ]);
  return {
    showcasePresentations: presentations.map((row) => rowToSnapshot(row)),
    projectPdfVersions: files.map((row) => ({ ...row, groupId: row.groupId ?? undefined, kind: row.kind === 'pdf' ? 'pdf' : 'file',
      status: row.status as ProjectPdfVersion['status'], sha256: row.sha256 ?? undefined, size: row.size ?? undefined,
      submittedAt: row.submittedAt.toISOString(), createdAt: row.createdAt.toISOString() })),
  };
}
