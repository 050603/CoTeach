import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import type { Course, StudentAiProgress, LearningSignal, TeacherAgentDirective } from "@/lib/session/types";
import { prisma } from "./client";
import { projectGroupStorageId, projectGroupViewId } from "@/lib/platform/group-identity";
import { normalizeCourse } from "@/lib/session/actions";
import { createPblTemplateCourse, decodePblTemplate, encodePblTemplate } from "@/lib/platform/pbl-template";
import { loadShowcaseState } from "@/lib/showcase/state";
import { aggregateCommonIssues } from "@/lib/learning-analytics/analyzer";
import { listProjectDocumentVersions } from "@/lib/project-practice/versions";
import { loadCompanionState, persistCompanionState } from "@/lib/companion/server-store";
import { experimentConfigFromActivity, posttestOpenedAt } from "@/lib/platform/experiment";

export class ClassroomProjectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "ClassroomProjectionError"; }
}
export function assertImmutableClassroomDesign(before: Course, after: Course) {
  const { resources: _beforeResources, ...original } = encodePblTemplate(before).design;
  const { resources: _afterResources, ...updated } = encodePblTemplate({
    ...after,
    pblConfig: {
      ...after.pblConfig,
      makeArtifactMode: before.pblConfig?.makeArtifactMode,
      practiceWebSearchEnabled: before.pblConfig?.practiceWebSearchEnabled,
    } as Course["pblConfig"],
  }).design;
  void _beforeResources; void _afterResources;
  // Every session action passes through normalizeCourse. Generated templates can
  // still contain their authored stage descriptions and a pre-normalized
  // evaluation plan, so comparing an action result only with the raw snapshot
  // incorrectly treats START_TEACHING (and other runtime-only actions) as a
  // published-design edit. Accept the complete canonical projection of the same
  // snapshot while still rejecting any value that differs from both forms.
  const canonical = encodePblTemplate(normalizeCourse(before)).design;
  const { resources: _canonicalResources, ...defaults } = canonical; void _canonicalResources;
  if (!isDeepStrictEqual(json(original), json(updated)) && !isDeepStrictEqual(json(defaults), json(updated))) throw new ClassroomProjectionError("CLASSROOM_DESIGN_IMMUTABLE", "课堂已固定发布教案，请在课程库编辑新版本并安排新的课堂场次");
}
export function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parseNotes(value: string | null): Record<string, unknown> { try { return object(JSON.parse(value ?? "{}")); } catch { return {}; } }
function view<T>(value: unknown): T { return object(value).view as T; }
type StoredCourseResource = {
  id: string;
  title: string;
  type: string;
  description: string | null;
  metadata: unknown;
  fileAsset: { id: string; size: bigint; deletedAt: Date | null } | null;
};

/** Build the browser-facing resource from its durable Resource/FileAsset pair. */
export function projectStoredCourseResource(resource: StoredCourseResource): NonNullable<Course["resources"]>[number] {
  const metadata = object(resource.metadata);
  const activeFile = resource.fileAsset && !resource.fileAsset.deletedAt
    ? resource.fileAsset
    : null;
  return {
    ...metadata,
    id: resource.id,
    title: resource.title,
    type: resource.type,
    size: activeFile ? String(activeFile.size) : "",
    description: resource.description ?? undefined,
    downloadedBy: metadata.downloadedBy as string[] ?? [],
    // Upload metadata intentionally does not persist an access URL. Always
    // derive it from the owned FileAsset so classroom snapshots cannot lose
    // the media source or trust a stale/foreign URL from JSON metadata.
    ...(activeFile ? { url: `/api/uploads/${activeFile.id}` } : {}),
  } as NonNullable<Course["resources"]>[number];
}
const selectInstance = { templateVersion: true, activity: { include: { chapter: { include: { offering: { include: { teachers: true, invitations: { where: { status: "ACTIVE" }, take: 1 } } } } } } }, participations: { include: { enrollment: { include: { user: true } } } } } satisfies Prisma.ClassroomInstanceInclude;

/** Old UI Course is a read projection, never a stored aggregate or a legacy table. */
export async function loadInstanceCourse(id: string, db: Prisma.TransactionClient = prisma): Promise<Course | undefined> {
  const instance = await db.classroomInstance.findUnique({ where: { id }, include: selectInstance });
  if (!instance) return undefined;
  const offeringId = instance.activity.chapter.offeringId;
  const participationIds = instance.participations.map(p => p.id);
  const groupViewId = (groupId: string) => projectGroupViewId(offeringId, groupId);
  const runtime = object(instance.runtimeConfig);
  const base = createPblTemplateCourse(id, decodePblTemplate(instance.templateVersion.snapshot) ?? { name: instance.activity.title }, { createdAt: instance.createdAt.toISOString(), updatedAt: instance.updatedAt.toISOString() });
  const [submissions, reflections, evaluations, supports, interventions, groups, announcements, todos, resources, signals, directives, events, workspaces, companions] = await Promise.all([
    db.classroomSubmission.findMany({ where: { participationId: { in: participationIds } } }),
    db.reflection.findMany({ where: { participationId: { in: participationIds } } }),
    db.evaluation.findMany({ where: { participationId: { in: participationIds } } }),
    db.aiSupportRecord.findMany({ where: { offeringId, OR: [{ participationId: { in: participationIds } }, { structuredPayload: { path: ["instanceId"], equals: id } }] } }),
    db.intervention.findMany({ where: { offeringId, metadata: { path: ["instanceId"], equals: id } } }),
    db.projectGroup.findMany({ where: { offeringId }, include: { members: { where: { leftAt: null }, include: { user: true } }, board: true, workPlanItems: { where: { activityId: instance.activityId } } } }),
    db.announcement.findMany({ where: { classroomInstanceId: id, archivedAt: null }, include: { replies: true, createdBy: { select: { displayName: true } } } }),
    db.todo.findMany({ where: { offeringId, activityId: instance.activityId, status: "ACTIVE" }, include: { completions: true } }),
    db.resource.findMany({ where: { offeringId, OR: [{ activityId: instance.activityId }, { activityId: null }] }, include: { fileAsset: true } }),
    db.learningSignal.findMany({ where: { participationId: { in: participationIds } } }),
    db.teacherAgentDirective.findMany({ where: { offeringId, OR: [{ participationId: { in: participationIds } }, { payload: { path: ["instanceId"], equals: id } }] } }),
    db.learningEvent.findMany({ where: { classroomInstanceId: id }, orderBy: { receivedAt: "desc" }, take: 10000 }),
    db.studentProjectWorkspace.findMany({ where: { participationId: { in: participationIds } } }),
    loadCompanionState(id, db),
  ]);
  const [experimentAssignments, experimentDrafts, experimentPosttests] = await Promise.all([
    db.experimentAssessmentAssignment.findMany({ where: { instanceId: id }, select: { enrollmentId: true } }),
    db.experimentAssessmentDraft.findMany({ where: { assignment: { instanceId: id }, phase: "posttest" }, select: { assignment: { select: { enrollmentId: true } } } }),
    db.experimentAssessmentSubmission.findMany({ where: { instanceId: id, phase: "posttest" }, select: { enrollmentId: true } }),
  ]);
  const draftEnrollments = new Set(experimentDrafts.map(item => item.assignment.enrollmentId));
  const submittedEnrollments = new Set(experimentPosttests.map(item => item.enrollmentId));
  const experimentStudentRows = instance.participations.map(item => ({
    studentId: item.enrollment.userId,
    status: submittedEnrollments.has(item.enrollmentId) ? "submitted" as const : draftEnrollments.has(item.enrollmentId) ? "in-progress" as const : "not-started" as const,
  }));
  const findUser = (participationId: string) => instance.participations.find(p => p.id === participationId)?.enrollment.user;
  const collection = <K extends keyof Course>(rows: Array<{ metadata: unknown }>, name: K): Course[K] => Array.from(new Map(rows.filter(r => object(r.metadata).collection === name).map(r => { const item = view<{ id: string }>(r.metadata); return [item.id, item]; })).values()) as Course[K];
  const uploadViews = collection(submissions.filter(submission => submission.status !== "ARCHIVED").map(submission => ({ metadata: submission.payload })), "uploads") ?? [];
  const uploadAssets = uploadViews.length ? await db.fileAsset.findMany({ where: { id: { in: uploadViews.map(upload => upload.id) }, deletedAt: null }, select: { id: true, offeringId: true, uploadedById: true, originalName: true, mimeType: true, size: true } }) : [];
  const uploads = uploadViews.flatMap(upload => {
    const asset = uploadAssets.find(item => item.id === upload.id && item.offeringId === offeringId && item.uploadedById === upload.studentId);
    return asset ? [{ ...upload, fileName: asset.originalName, fileType: asset.mimeType, size: String(asset.size), url: `/api/uploads/${asset.id}` }] : [];
  });
  return {
    ...base, ...companions, ...await loadShowcaseState(id, db),
    uploads,
    projectDocumentVersions: await listProjectDocumentVersions({ courseId: id }, db),
    activityLog: (await db.domainEvent.findMany({ where: { classroomInstanceId: id, eventType: "CLASSROOM_ACTIVITY" }, orderBy: { createdAt: "desc" }, take: 300 })).map(e => view<NonNullable<Course["activityLog"]>[number]>(e.payload)),
    platformContext: { offeringId, activityId: instance.activityId, templateId: instance.templateVersion.templateId, templateVersionId: instance.templateVersionId },
    experimentPosttestSummary: {
      enabled: Boolean(experimentAssignments.length || experimentConfigFromActivity(instance.activity.config)),
      ...(posttestOpenedAt(instance.runtimeConfig) ? { openedAt: posttestOpenedAt(instance.runtimeConfig)! } : {}),
      notStartedCount: experimentStudentRows.filter(item => item.status === "not-started").length,
      inProgressCount: experimentStudentRows.filter(item => item.status === "in-progress").length,
      submittedCount: experimentStudentRows.filter(item => item.status === "submitted").length,
      studentRows: experimentStudentRows,
    },
    name: instance.activity.title, version: Number(runtime.version ?? 1),
    status: instance.status.toUpperCase() === "TEACHING" ? "teaching" : instance.status.toUpperCase() === "FINISHED" ? "finished" : "ready",
    currentStageIndex: Number(runtime.currentStageIndex ?? 0),
    pblConfig: {
      ...base.pblConfig,
      ...(runtime.makeArtifactMode ? { makeArtifactMode: runtime.makeArtifactMode } : {}),
      ...(typeof runtime.practiceWebSearchEnabled === "boolean" ? { practiceWebSearchEnabled: runtime.practiceWebSearchEnabled } : {}),
    } as Course["pblConfig"],
    classConfig: runtime.classConfig as Course["classConfig"], uiState: runtime.uiState as Course["uiState"],
    presentingStudentId: runtime.presentingStudentId as string | undefined, presentingGroupId: runtime.presentingGroupId as string | undefined,
    inviteCode: instance.activity.chapter.offering.invitations[0]?.code,
    content: { ...base.content, ...(runtime.courseSummaryPresentation ? { courseSummaryPresentation: runtime.courseSummaryPresentation as Course["content"]["courseSummaryPresentation"] } : {}) },
    students: instance.participations.map(p => ({ id: p.enrollment.userId, name: p.enrollment.user.displayName, joinedAt: (p.firstEnteredAt ?? p.enrollment.joinedAt).toISOString(), stageProgress: object(p.stageProgress).progress as Record<string, number> ?? {}, lastSeenAt: p.lastEnteredAt?.toISOString() })),
    aiLearningProgress: Object.fromEntries(workspaces.flatMap(w => { const user = findUser(w.participationId); const progress = object(w.projectState).aiLearningProgress as StudentAiProgress | undefined; return user && progress ? [[user.id, progress]] : []; })),
    submissions: Array.from(new Map(submissions.filter(s => !s.stageKey.startsWith("evidence:")).map(s => { const value: NonNullable<Course["submissions"]>[number] = view<Course["submissions"] extends Array<infer T> | undefined ? T : never>(s.payload) ?? { id: s.id, courseId: id, studentId: findUser(s.participationId)?.id, stageKey: s.stageKey, type: "document", title: s.stageKey, content: JSON.stringify(s.payload), createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }; return [value.id, value]; })).values()),
    reflections: reflections.map(r => view<NonNullable<Course["reflections"]>[number]>(r.metadata) ?? { id: r.id, courseId: id, studentId: findUser(r.participationId)?.id ?? "", studentName: findUser(r.participationId)?.displayName ?? "", content: r.content, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }),
    evaluations: collection(evaluations, "evaluations"), feedback: collection(evaluations, "feedback"), rubricScores: collection(evaluations, "rubricScores"), learningEvidence: collection(submissions.map(s => ({ metadata: s.payload })), "learningEvidence"), artifactSnapshots: collection(submissions.map(s => ({ metadata: s.payload })), "artifactSnapshots"), aiAssessmentSuggestions: supports.filter(s => object(s.structuredPayload).collection === "aiAssessmentSuggestions").map(s => view(s.structuredPayload)),
    aiSupports: supports.filter(s => object(s.structuredPayload).collection === "aiSupports").map(s => view(s.structuredPayload)),
    aiContributions: supports.filter(s => object(s.structuredPayload).collection === "aiContributions").map(s => view(s.structuredPayload)),
    studentAiDecisions: supports.filter(s => object(s.structuredPayload).collection === "studentAiDecisions").map(s => view(s.structuredPayload)),
    teacherInterventions: collection(interventions, "teacherInterventions"), offlineInterventions: collection(interventions, "offlineInterventions"), stageTransitions: collection(interventions, "stageTransitions"), dynamicFacilitationScaffolds: collection(interventions, "dynamicFacilitationScaffolds"),
    groups: groups.map(g => ({ ...object(object(g.board?.snapshot).proposal), id: groupViewId(g.id), name: g.name, topic: String(object(object(g.board?.snapshot).proposal).topic ?? ""), keywords: object(object(g.board?.snapshot).proposal).keywords as string[] ?? [], selectedForms: object(object(g.board?.snapshot).proposal).selectedForms as string[] ?? [], members: g.members.map(m => ({ studentId: m.userId, name: m.user.displayName, role: m.role })), createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString() })),
    boards: groups.flatMap(g => { const data = object(g.board?.snapshot); return data.board ? [data.board as NonNullable<Course["boards"]>[number]] : []; }),
    whiteboard: groups.flatMap(g => object(g.board?.snapshot).nodes as NonNullable<Course["whiteboard"]> ?? []),
    workPlan: groups.flatMap(g => g.workPlanItems.map(w => ({ id: w.id, groupId: groupViewId(g.id), role: String(parseNotes(w.description).role ?? "成员"), memberName: g.members.find(m => m.userId === w.assigneeId)?.user.displayName ?? String(parseNotes(w.description).memberName ?? ""), task: w.title, progress: w.status === "DONE" ? 100 : Number(parseNotes(w.description).progress ?? 0) }))),
    announcements: announcements.filter(a => !a.groupId).map(a => ({ id: a.id, title: a.title, content: a.content, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(), replies: a.replies.map(r => ({ id: r.id, studentId: r.authorId, studentName: instance.participations.find(p => p.enrollment.userId === r.authorId)?.enrollment.user.displayName ?? "教师", content: r.content, createdAt: r.createdAt.toISOString() })) })) as Course["announcements"],
    groupAnnouncements: announcements.filter(a => a.groupId).map(a => ({ id: a.id, groupId: groupViewId(a.groupId!), title: a.title, content: a.content, actor: a.createdBy.displayName, createdAt: a.createdAt.toISOString() })) as Course["groupAnnouncements"],
    todos: todos.map(t => ({ id: t.id, title: t.title, description: t.description ?? "", completedBy: t.completions.map(c => c.userId) })),
    resources: [
      ...(base.resources ?? []).filter(r => !resources.some(stored => stored.id === r.id)),
      ...resources.map(projectStoredCourseResource),
    ] as Course["resources"],
    teamContributions: collection(submissions.map(s => ({ metadata: s.payload })), "teamContributions"),
    classCommonIssues: aggregateCommonIssues(signals.map(s => view<LearningSignal>(s.payload)).filter(Boolean), instance.participations.length),
    resolvedInterventionSignalIds: runtime.resolvedInterventionSignalIds as string[] ?? [],
    learningSignals: signals.map(s => view<LearningSignal>(s.payload)).filter(Boolean),
    teacherAgentDirectives: directives.map(d => view<TeacherAgentDirective>(d.payload)).filter(Boolean),
    learningEvents: events.reverse().map(e => object(e.metadata).legacy ?? object(e.metadata).view).filter(Boolean) as Course["learningEvents"],
  };
}

/** Persist changed domain entities in their V2 tables; never replace unrelated participants. */
export async function persistInstanceCourse(db: Prisma.TransactionClient, before: Course, after: Course, actor?: { id: string; role: string }) {
  const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: before.id }, include: selectInstance });
  const offeringId = instance.activity.chapter.offeringId;
  // Recheck after the transaction lock: a student request may have waited behind classroom closure.
  if (actor?.role === "student") {
    const enrollment = instance.participations.find(participant => participant.enrollment.userId === actor.id)?.enrollment;
    if (instance.status.toUpperCase() !== "TEACHING" || enrollment?.status.toUpperCase() !== "ACTIVE" || instance.activity.chapter.offering.status.toUpperCase() !== "OPEN") {
      throw new ClassroomProjectionError("CLASSROOM_READ_ONLY", "课堂或选课状态已改变，当前仅可查看记录", 409);
    }
  }
  if (instance.status.toUpperCase() === "FINISHED" && (
    !isDeepStrictEqual(before.classConfig, after.classConfig)
    || before.pblConfig?.makeArtifactMode !== after.pblConfig?.makeArtifactMode
    || before.pblConfig?.practiceWebSearchEnabled !== after.pblConfig?.practiceWebSearchEnabled
  )) throw new ClassroomProjectionError("CLASSROOM_READ_ONLY", "已结束场次的运行配置不可修改");
  if (before.status !== after.status && after.status === "teaching" && instance.activity.chapter.offering.status.toUpperCase() !== "OPEN") throw new ClassroomProjectionError("CLASSROOM_READ_ONLY", "课程当前不可开始授课");
  assertImmutableClassroomDesign(before, after);
  const storedGroupId = (groupId: string) => projectGroupStorageId(offeringId, groupId);
  if (before.status !== after.status && !((before.status === "ready" && after.status === "teaching") || (before.status === "teaching" && after.status === "finished"))) throw new ClassroomProjectionError("CLASSROOM_STATE_CONFLICT", "已结束的课堂不可重新开启，请创建新的课堂场次");
  if (actor?.role === "teacher" && !instance.activity.chapter.offering.teachers.some(teacher => teacher.userId === actor.id)) throw new ClassroomProjectionError("FORBIDDEN", "无权修改此课堂", 403);
  const creator = (existingId?: string, ownerId?: string): string => {
    const id = actor?.id ?? existingId ?? ownerId;
    if (!id) throw new ClassroomProjectionError("CLASSROOM_ACTOR_REQUIRED", "保存此课堂记录需要明确的操作人", 403);
    return id;
  };
  const participationFor = (studentId?: string) => instance.participations.find(p => p.enrollment.userId === studentId);
  const participantsFor = (row: Record<string, unknown>, allowCourse = false) => {
    const studentId = typeof row.studentId === "string" ? row.studentId : row.targetType === "student" && typeof row.targetId === "string" ? row.targetId : undefined;
    if (studentId) { const participant = participationFor(studentId); if (!participant) throw new ClassroomProjectionError("PARTICIPATION_REQUIRED", "目标学生不在当前课堂", 400); return [participant]; }
    const groupId = typeof row.groupId === "string" ? row.groupId : row.targetType === "group" && typeof row.targetId === "string" ? row.targetId : undefined;
    if (groupId) {
      const group = after.groups?.find(item => item.id === groupId);
      if (!group) throw new ClassroomProjectionError("GROUP_SCOPE_MISMATCH", "目标小组不在当前课堂", 400);
      const participants = instance.participations.filter(participant => group.members.some(member => member.studentId === participant.enrollment.userId));
      if (!participants.length) throw new ClassroomProjectionError("PARTICIPATION_REQUIRED", "目标小组尚无课堂参与记录", 400);
      return participants;
    }
    if (allowCourse && row.targetType === "course" && row.targetId === before.id) return instance.participations;
    throw new ClassroomProjectionError("PARTICIPATION_REQUIRED", "课堂记录必须指定学生或小组", 400);
  };
  const changed = <K extends keyof Course>(key: K) => {
    const old = (before[key] ?? []) as Array<{ id?: string }>;
    return ((after[key] ?? []) as Array<{ id?: string }>).filter(row => JSON.stringify(old.find(item => item.id === row.id)) !== JSON.stringify(row));
  };
  const meta = (collection: string, row: unknown) => json({ instanceId: instance.id, collection, provenance: actor ? { actorId: actor.id, actorRole: actor.role } : { actorRole: "system" }, view: row });
  const current = object(instance.runtimeConfig);
  const transitionAt = new Date();
  const opensPosttest = after.stages[after.currentStageIndex]?.key === "reflection" && after.status === "teaching";
  await db.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: json({ ...current, ...(opensPosttest && !posttestOpenedAt(current) ? { posttestOpenedAt: transitionAt.toISOString() } : {}), version: (before.version ?? 1) + 1, currentStageIndex: after.currentStageIndex, classConfig: after.classConfig, makeArtifactMode: after.pblConfig?.makeArtifactMode, practiceWebSearchEnabled: after.pblConfig?.practiceWebSearchEnabled, uiState: after.uiState, presentingStudentId: after.presentingStudentId, presentingGroupId: after.presentingGroupId, resolvedInterventionSignalIds: after.resolvedInterventionSignalIds, courseSummaryPresentation: after.content.courseSummaryPresentation }), status: after.status === "teaching" ? "TEACHING" : after.status === "finished" ? "FINISHED" : "SCHEDULED", ...(after.status === "teaching" && !instance.startedAt ? { startedAt: transitionAt } : {}), ...(after.status === "finished" && !instance.endedAt ? { endedAt: transitionAt } : {}) } });
  if (before.status !== after.status) {
    const action = after.status === "teaching" ? "start" : "finish";
    if (action === "finish") await db.classroomParticipation.updateMany({ where: { instanceId: instance.id, completedAt: null }, data: { completedAt: transitionAt } });
    await db.domainEvent.upsert({ where: { idempotencyKey: `classroom:${instance.id}:${action}` }, create: { idempotencyKey: `classroom:${instance.id}:${action}`, actorId: actor?.id, offeringId, classroomInstanceId: instance.id, eventType: `classroom_${action === "start" ? "started" : "finished"}`, payload: { previousStatus: instance.status.toUpperCase(), status: after.status === "teaching" ? "TEACHING" : "FINISHED" } }, update: {} });
  }
  for (const student of after.students) {
    const participation = participationFor(student.id);
    if (!participation) continue;
    const previous = before.students.find(s => s.id === student.id);
    if (JSON.stringify(previous) !== JSON.stringify(student)) await db.classroomParticipation.update({ where: { id: participation.id }, data: { stageProgress: json({ ...object(participation.stageProgress), progress: student.stageProgress }), ...(student.lastSeenAt ? { lastEnteredAt: new Date(student.lastSeenAt) } : {}) } });
    const aiProgress = after.aiLearningProgress?.[student.id];
    if (aiProgress && JSON.stringify(aiProgress) !== JSON.stringify(before.aiLearningProgress?.[student.id])) {
      const workspace = await db.studentProjectWorkspace.findUnique({ where: { participationId: participation.id } });
      await db.studentProjectWorkspace.upsert({ where: { participationId: participation.id }, create: { participationId: participation.id, projectState: json({ aiLearningProgress: aiProgress }) }, update: { projectState: json({ ...object(workspace?.projectState), aiLearningProgress: aiProgress }), version: { increment: 1 } } });
    }
  }
  for (const row of changed("submissions") as NonNullable<Course["submissions"]>) {
    for (const p of participantsFor(row as unknown as Record<string, unknown>)) {
    await db.classroomSubmission.upsert({ where: { participationId_stageKey: { participationId: p.id, stageKey: `${row.stageKey}:${row.type}` } }, create: { participationId: p.id, stageKey: `${row.stageKey}:${row.type}`, payload: meta("submissions", row), status: (row.status ?? "submitted").toUpperCase(), submittedAt: new Date(row.submittedAt ?? row.updatedAt) }, update: { payload: meta("submissions", row), status: (row.status ?? "submitted").toUpperCase(), submittedAt: new Date(row.submittedAt ?? row.updatedAt) } });
    }
  }
  for (const upload of changed("uploads") as NonNullable<Course["uploads"]>) {
    const asset = await db.fileAsset.findUnique({ where: { id: upload.id } });
    if (!asset || asset.deletedAt || asset.offeringId !== offeringId) throw new ClassroomProjectionError("UPLOAD_SCOPE_MISMATCH", "上传文件不属于当前课程", 400);
    const participant = participationFor(asset.uploadedById);
    if (!participant || (upload.studentId && upload.studentId !== asset.uploadedById) || (actor?.role === "student" && actor.id !== asset.uploadedById)) throw new ClassroomProjectionError("UPLOAD_SCOPE_MISMATCH", "上传文件不属于该学生", 403);
    if (upload.groupId && !after.groups?.some(group => group.id === upload.groupId && group.members.some(member => member.studentId === asset.uploadedById))) throw new ClassroomProjectionError("UPLOAD_GROUP_SCOPE_MISMATCH", "上传文件不属于该小组", 403);
    const canonical = { ...upload, studentId: asset.uploadedById, fileName: asset.originalName, fileType: asset.mimeType, size: String(asset.size), url: `/api/uploads/${asset.id}` };
    const stageKey = `evidence:uploads:${upload.id}`;
    await db.classroomSubmission.upsert({ where: { participationId_stageKey: { participationId: participant.id, stageKey } }, create: { participationId: participant.id, stageKey, status: "SUBMITTED", payload: meta("uploads", canonical), submittedAt: new Date() }, update: { status: "SUBMITTED", payload: meta("uploads", canonical) } });
  }
  for (const upload of before.uploads ?? []) {
    if (after.uploads?.some(item => item.id === upload.id)) continue;
    const participant = participationFor(upload.studentId);
    if (participant) await db.classroomSubmission.updateMany({ where: { participationId: participant.id, stageKey: `evidence:uploads:${upload.id}` }, data: { status: "ARCHIVED" } });
  }
  for (const row of changed("reflections") as NonNullable<Course["reflections"]>) {
    const p = participationFor(row.studentId); if (!p) throw new Error("REFLECTION_PARTICIPATION_REQUIRED");
    const previous = await db.reflection.findUnique({ where: { id: row.id } }); if (previous && previous.participationId !== p.id) throw new Error("REFLECTION_SCOPE_MISMATCH");
    await db.reflection.upsert({ where: { id: row.id }, create: { id: row.id, participationId: p.id, activityId: instance.activityId, authorId: row.studentId, content: row.content, metadata: meta("reflections", row) }, update: { content: row.content, metadata: meta("reflections", row) } });
  }
  for (const collection of ["learningEvidence", "artifactSnapshots", "teamContributions"] as const) for (const item of changed(collection)) {
    const row = item as Record<string, unknown>;
    for (const p of participantsFor(row)) {
    const stageKey = `evidence:${collection}:${item.id}`;
    const status = typeof row.status === "string" ? row.status.toUpperCase().replaceAll("-", "_") : "SUBMITTED";
    await db.classroomSubmission.upsert({ where: { participationId_stageKey: { participationId: p.id, stageKey } }, create: { participationId: p.id, stageKey, status, payload: meta(collection, item), submittedAt: status === "DRAFT" ? null : new Date() }, update: { status, payload: meta(collection, item), submittedAt: status === "DRAFT" ? null : new Date() } });
    }
  }
  for (const collection of ["evaluations", "feedback", "rubricScores"] as const) {
    for (const item of changed(collection)) {
      const row = item as Record<string, unknown>;
      const participants = participantsFor(row, true);
      for (const p of participants) { if (!p) continue;
        const id = `${collection}:${item.id}:${p.id}`;
        const data = { participationId: p.id, studentId: p.enrollment.userId, activityId: instance.activityId, type: collection.toUpperCase(), evaluatorType: row.sourceRole === "ai" ? "AI" : actor?.role.toUpperCase() ?? "SYSTEM", evaluatorId: row.sourceRole === "ai" ? undefined : actor?.id, score: typeof (row.score ?? row.total ?? row.finalTotal) === "number" ? Number(row.score ?? row.total ?? row.finalTotal) : undefined, rubric: row.dimensionScores ? json(row.dimensionScores) : undefined, result: json(item), content: String(row.content ?? row.comment ?? row.summary ?? ""), metadata: meta(collection, item) };
        await db.evaluation.upsert({ where: { id }, create: { id, ...data }, update: data });
      }
    }
  }
  for (const collection of ["aiSupports", "aiContributions", "studentAiDecisions", "aiAssessmentSuggestions"] as const) for (const item of changed(collection)) {
    const row = item as Record<string, unknown>; const p = participationFor(typeof row.studentId === "string" ? row.studentId : undefined);
    const previous = await db.aiSupportRecord.findUnique({ where: { id: `${instance.id}:${collection}:${item.id}` } });
    const data = { offeringId, participationId: p?.id, createdById: creator(previous?.createdById, p?.enrollment.userId), type: collection.toUpperCase(), status: String(row.status ?? "OPEN"), summary: String(row.diagnosis ?? row.summary ?? ""), structuredPayload: meta(collection, item) };
    await db.aiSupportRecord.upsert({ where: { id: `${instance.id}:${collection}:${item.id}` }, create: { id: `${instance.id}:${collection}:${item.id}`, ...data }, update: { ...data, createdById: undefined } });
  }
  for (const collection of ["teacherInterventions", "offlineInterventions", "stageTransitions", "dynamicFacilitationScaffolds"] as const) for (const item of changed(collection)) {
    const row = item as Record<string, unknown>;
    const previous = await db.intervention.findUnique({ where: { id: `${instance.id}:${collection}:${item.id}` } });
    const data = { offeringId, createdById: creator(previous?.createdById), channel: "CLASSROOM", type: collection.toUpperCase(), content: String(row.content ?? row.summary ?? ""), metadata: meta(collection, item) };
    await db.intervention.upsert({ where: { id: `${instance.id}:${collection}:${item.id}` }, create: { id: `${instance.id}:${collection}:${item.id}`, ...data }, update: { ...data, createdById: undefined } });
  }
  for (const group of after.groups ?? []) {
    const previous = before.groups?.find(g => g.id === group.id);
    if (JSON.stringify(previous) === JSON.stringify(group) && JSON.stringify(before.boards) === JSON.stringify(after.boards) && JSON.stringify(before.whiteboard) === JSON.stringify(after.whiteboard)) continue;
    const existing = await db.projectGroup.findUnique({ where: { id: storedGroupId(group.id) } });
    if (existing && existing.offeringId !== offeringId) throw new Error("GROUP_SCOPE_MISMATCH");
    await db.projectGroup.upsert({ where: { id: storedGroupId(group.id) }, create: { id: storedGroupId(group.id), offeringId, name: group.name }, update: { name: group.name } });
    const snapshot = json({ proposal: { topic: group.topic, goal: group.goal, keywords: group.keywords, selectedForms: group.selectedForms, proposal: group.proposal, teacherApproval: group.teacherApproval }, board: after.boards?.find(b => b.groupId === group.id), nodes: after.whiteboard?.filter(n => n.groupId === group.id) ?? [] });
    await db.groupBoard.upsert({ where: { groupId: storedGroupId(group.id) }, create: { groupId: storedGroupId(group.id), snapshot }, update: { snapshot, version: { increment: 1 } } });
    await db.groupMember.updateMany({ where: { groupId: storedGroupId(group.id), userId: { notIn: group.members.map(m => m.studentId) } }, data: { leftAt: new Date() } });
    for (const member of group.members) { const p = participationFor(member.studentId); if (!p) throw new Error("GROUP_MEMBER_SCOPE_MISMATCH"); await db.groupMember.upsert({ where: { groupId_userId: { groupId: storedGroupId(group.id), userId: member.studentId } }, create: { groupId: storedGroupId(group.id), userId: member.studentId, participationId: p.id, role: member.role ?? "MEMBER" }, update: { participationId: p.id, role: member.role ?? "MEMBER", leftAt: null } }); }
  }
  for (const row of changed("announcements") as NonNullable<Course["announcements"]>) {
    const previous = await db.announcement.findUnique({ where: { id: row.id } }); if (previous && previous.classroomInstanceId !== instance.id) throw new Error("ANNOUNCEMENT_SCOPE_MISMATCH");
    await db.announcement.upsert({ where: { id: row.id }, create: { id: row.id, offeringId, classroomInstanceId: instance.id, createdById: creator(previous?.createdById), scope: "CLASSROOM", title: row.title, content: row.content }, update: { title: row.title, content: row.content } });
    for (const reply of row.replies) { const data = { announcementId: row.id, authorId: reply.studentId ?? creator(previous?.createdById), content: reply.content }; await db.announcementReply.upsert({ where: { id: reply.id }, create: { id: reply.id, ...data }, update: {} }); }
  }
  const removedAnnouncements = before.announcements?.filter(a => !after.announcements?.some(b => b.id === a.id)).map(a => a.id) ?? [];
  if (removedAnnouncements.length) await db.announcement.updateMany({ where: { id: { in: removedAnnouncements }, classroomInstanceId: instance.id }, data: { archivedAt: new Date() } });
  for (const row of changed("todos") as NonNullable<Course["todos"]>) {
    const previous = await db.todo.findUnique({ where: { id: row.id } }); if (previous && (previous.offeringId !== offeringId || previous.activityId !== instance.activityId)) throw new Error("TODO_SCOPE_MISMATCH");
    await db.todo.upsert({ where: { id: row.id }, create: { id: row.id, offeringId, activityId: instance.activityId, createdById: creator(previous?.createdById), title: row.title, description: row.description }, update: { title: row.title, description: row.description } });
    await db.todoCompletion.deleteMany({ where: { todoId: row.id, userId: { notIn: row.completedBy } } });
    for (const userId of row.completedBy) { if (!participationFor(userId)) throw new Error("TODO_STUDENT_SCOPE_MISMATCH"); await db.todoCompletion.upsert({ where: { todoId_userId: { todoId: row.id, userId } }, create: { todoId: row.id, userId }, update: {} }); }
  }
  for (const row of changed("resources") as NonNullable<Course["resources"]>) {
    const previous = await db.resource.findUnique({ where: { id: row.id } }); if (previous && (previous.offeringId !== offeringId || (previous.activityId && previous.activityId !== instance.activityId))) throw new Error("RESOURCE_SCOPE_MISMATCH");
    await db.resource.upsert({ where: { id: row.id }, create: { id: row.id, offeringId, activityId: instance.activityId, createdById: creator(previous?.createdById), title: row.title, type: row.type, description: row.description, metadata: json(row) }, update: { title: row.title, description: row.description, metadata: json(row) } });
  }
  for (const row of changed("workPlan") as NonNullable<Course["workPlan"]>) {
    const group = after.groups?.find(g => g.id === row.groupId); if (!group) throw new Error("WORK_PLAN_GROUP_REQUIRED");
    const existing = await db.workPlanItem.findUnique({ where: { id: row.id } });
    if (existing && existing.groupId !== storedGroupId(row.groupId)) throw new Error("WORK_PLAN_SCOPE_MISMATCH");
    const candidates = group.members.filter(member => member.name === row.memberName);
    const retained = existing?.assigneeId && candidates.some(member => member.studentId === existing.assigneeId) ? existing.assigneeId : undefined;
    if (candidates.length > 1 && !retained) throw new ClassroomProjectionError("AMBIGUOUS_ASSIGNEE", "小组中有同名成员，请先区分成员姓名后再分配任务");
    const assigneeId = retained ?? (candidates.length === 1 ? candidates[0].studentId : null);
    const data = { groupId: storedGroupId(row.groupId), activityId: instance.activityId, assigneeId, title: row.task, description: JSON.stringify({ progress: row.progress, role: row.role, memberName: row.memberName }), status: row.progress >= 100 ? "DONE" : "TODO" };
    await db.workPlanItem.upsert({ where: { id: row.id }, create: { id: row.id, ...data }, update: data });
  }
  const removedPlans = before.workPlan?.filter(item => !after.workPlan?.some(next => next.id === item.id)).map(item => item.id) ?? [];
  if (removedPlans.length) await db.workPlanItem.deleteMany({ where: { id: { in: removedPlans }, activityId: instance.activityId } });
  for (const row of changed("groupAnnouncements") as NonNullable<Course["groupAnnouncements"]>) {
    if (!after.groups?.some(g => g.id === row.groupId)) throw new Error("ANNOUNCEMENT_GROUP_SCOPE_MISMATCH");
    const previous = await db.announcement.findUnique({ where: { id: row.id } }); if (previous && previous.classroomInstanceId !== instance.id) throw new Error("ANNOUNCEMENT_SCOPE_MISMATCH");
    const data = { offeringId, classroomInstanceId: instance.id, groupId: storedGroupId(row.groupId), createdById: creator(previous?.createdById), scope: "GROUP", title: row.title, content: row.content };
    await db.announcement.upsert({ where: { id: row.id }, create: { id: row.id, ...data }, update: { ...data, createdById: undefined } });
  }
  for (const row of changed("activityLog") as NonNullable<Course["activityLog"]>) {
    await db.domainEvent.upsert({ where: { idempotencyKey: `activity:${instance.id}:${row.id}` }, create: { idempotencyKey: `activity:${instance.id}:${row.id}`, actorId: actor?.id, offeringId, classroomInstanceId: instance.id, eventType: "CLASSROOM_ACTIVITY", payload: meta("activityLog", row) }, update: {} });
  }
  for (const row of changed("learningSignals") as NonNullable<Course["learningSignals"]>) {
    const p = participationFor(row.studentId); if (!p) throw new Error("SIGNAL_PARTICIPATION_REQUIRED");
    const data = { userId: row.studentId, offeringId, enrollmentId: p.enrollmentId, participationId: p.id, type: row.kind, severity: row.severity, status: row.status, payload: meta("learningSignals", row) };
    await db.learningSignal.upsert({ where: { id: `${p.id}:${row.id}` }, create: { id: `${p.id}:${row.id}`, ...data }, update: data });
  }
  for (const row of changed("teacherAgentDirectives") as NonNullable<Course["teacherAgentDirectives"]>) {
    if (row.targetStudentIds.some(id => !participationFor(id))) throw new Error("DIRECTIVE_STUDENT_SCOPE_MISMATCH");
    const previous = await db.teacherAgentDirective.findUnique({ where: { id: `${instance.id}:${row.id}` } });
    const data = { offeringId, createdById: creator(previous?.createdById), directiveType: row.targetScope, status: row.status, payload: meta("teacherAgentDirectives", row) };
    await db.teacherAgentDirective.upsert({ where: { id: `${instance.id}:${row.id}` }, create: { id: `${instance.id}:${row.id}`, ...data }, update: { ...data, createdById: undefined } });
  }
  await persistCompanionState(db, instance.id, before, after);
}
