import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { fetch as undiciFetch } from "undici";
import type { Course } from "@/lib/session/types";
import { prisma } from "@/lib/db/client";
import { getCourse } from "@/lib/session/server-store";
import {
  CLASSROOMS_DIR,
  isValidClassroomId,
  readClassroom,
  type PersistedClassroomData,
} from "@/lib/openmaic/server/classroom-storage";
import { audioDurationSec } from "@/lib/openmaic/audio/audio-duration";
import { createSsrfSafeDispatcher } from "@/lib/openmaic/server/ssrf-guard";
import {
  findMissingTeachingToolResources,
  findMissingTtsResources,
} from "@/lib/course-generation/resource-readiness";
import { findUnresolvedClassroomMedia } from "@/lib/openmaic/server/classroom-media-generation";
import { isMediaPlaceholder } from "@/lib/openmaic/store/media-generation";
import { resolveDurableCourseSceneOutlines } from "@/lib/course-generation/course-resource-outlines";
import { userFacingName } from "@/lib/user-facing-labels";

export type CourseResourceIssue = {
  id: string;
  type: "classroom" | "adaptive-resource" | "teaching-tool" | "tts" | "media" | "speech-sync";
  title: string;
  detail: string;
};

export type CourseResourceAuditSnapshot = {
  /** The exact course revision being published, rather than the latest editable draft. */
  course: Course;
  /** The classroom paired with that revision and already used for review-signature validation. */
  classroom: PersistedClassroomData;
};

const MANAGED_MEDIA_PREFIX = "/api/openmaic/classroom-media/";
const UPLOAD_MEDIA_PREFIX = "/api/uploads/";
// New assets use content-addressed `[a-zA-Z0-9_.-]` names. `:` remains
// readable only for classrooms generated before that filename contract was
// enforced, where blueprint action IDs were embedded in the filename.
const SAFE_PATH_PART = /^[a-zA-Z0-9_.:-]+$/;
const REMOTE_RESOURCE_TIMEOUT_MS = 8_000;
const MAX_REMOTE_RESOURCE_BYTES = 25 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 3;

type ResourceBytes = { bytes: Uint8Array; format: string };
type ResourceIntegrity = { ok: true } | { ok: false; detail: string };

function managedMediaStoragePath(resourceUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(resourceUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(MANAGED_MEDIA_PREFIX)) return null;
  let parts: string[];
  try {
    parts = pathname.slice(MANAGED_MEDIA_PREFIX.length).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length < 3 || !isValidClassroomId(parts[0] ?? "")
    || parts.some((part) => part === "." || part === ".." || !SAFE_PATH_PART.test(part))) {
    return null;
  }
  return path.join(CLASSROOMS_DIR, ...parts);
}

function resourceFormat(resourceUrl: string, contentType = ""): string {
  const mediaType = contentType.toLowerCase().split(";", 1)[0]?.trim();
  if (mediaType?.startsWith("audio/")) return mediaType;
  let pathname = resourceUrl;
  try { pathname = new URL(resourceUrl, "http://localhost").pathname; } catch { /* use the raw value */ }
  return path.extname(pathname).slice(1).toLowerCase();
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) throw new Error("资源响应为空");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("资源文件超过检查大小限制");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readRemoteResource(resourceUrl: string): Promise<ResourceBytes> {
  let currentUrl = resourceUrl;
  for (let redirect = 0; redirect <= MAX_REMOTE_REDIRECTS; redirect += 1) {
    const connection = await createSsrfSafeDispatcher(currentUrl);
    try {
      const response = await undiciFetch(currentUrl, {
        dispatcher: connection.dispatcher,
        redirect: "manual",
        headers: {
          Accept: "audio/*,image/*,video/*,application/octet-stream",
          "User-Agent": "CoTeach-ResourceAudit/1.0",
        },
        signal: AbortSignal.timeout(REMOTE_RESOURCE_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirect === MAX_REMOTE_REDIRECTS) throw new Error("远程资源重定向无效");
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`远程资源返回 ${response.status}`);
      }
      const declaredSize = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_RESOURCE_BYTES) {
        await response.body?.cancel();
        throw new Error("远程资源文件超过检查大小限制");
      }
      const bytes = await readBoundedBody(
        response.body as unknown as ReadableStream<Uint8Array> | null,
        MAX_REMOTE_RESOURCE_BYTES,
      );
      return { bytes, format: resourceFormat(currentUrl, response.headers.get("content-type") ?? "") };
    } finally {
      await connection.close();
    }
  }
  throw new Error("远程资源重定向过多");
}

async function readResource(resourceUrl: string): Promise<ResourceBytes> {
  const managedPath = managedMediaStoragePath(resourceUrl);
  if (managedPath) {
    return { bytes: await fs.readFile(managedPath), format: resourceFormat(resourceUrl) };
  }
  if (/^https?:\/\//i.test(resourceUrl)) return readRemoteResource(resourceUrl);
  if (resourceUrl.startsWith(UPLOAD_MEDIA_PREFIX)) {
    const parsed = new URL(resourceUrl, "http://localhost");
    const uploadId = parsed.pathname.slice(UPLOAD_MEDIA_PREFIX.length);
    if (!/^[a-z\d-]+$/i.test(uploadId)) throw new Error("上传资源地址无效");
    const asset = await prisma.fileAsset.findFirst({
      where: { id: uploadId, deletedAt: null },
      select: { storageKey: true, mimeType: true, size: true },
    });
    if (!asset || path.basename(asset.storageKey) !== asset.storageKey) throw new Error("上传资源不存在");
    const uploadDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
    const bytes = await fs.readFile(path.join(uploadDir, asset.storageKey));
    if (BigInt(bytes.byteLength) !== asset.size) throw new Error("上传资源大小与记录不符");
    return { bytes, format: asset.mimeType };
  }
  const inline = /^data:((?:image|video|audio)\/[\w.+-]+);base64,([a-z\d+/=]+)$/i.exec(resourceUrl);
  if (inline) {
    const encoded = inline[2]!;
    if (encoded.length > Math.ceil(MAX_REMOTE_RESOURCE_BYTES * 4 / 3) + 4) {
      throw new Error("内嵌资源文件超过检查大小限制");
    }
    return { bytes: Buffer.from(encoded, "base64"), format: inline[1]! };
  }
  throw new Error("资源地址不属于可核验的课堂存储");
}

async function checkResourceIntegrity(resourceUrl: string, kind: "audio" | "image" | "video"): Promise<ResourceIntegrity> {
  try {
    const { bytes, format } = await readResource(resourceUrl);
    if (bytes.byteLength === 0) return { ok: false, detail: kind === "audio" ? "语音文件为空" : "媒体文件为空" };
    if (kind === "audio" && !audioDurationSec(bytes, format)) {
      return { ok: false, detail: "语音文件损坏或时长无效" };
    }
    if (kind === "image") {
      try {
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height) return { ok: false, detail: "图片文件损坏或尺寸无效" };
      } catch {
        return { ok: false, detail: "图片文件损坏或尺寸无效" };
      }
    }
    if (kind === "video") {
      const detected = await fileTypeFromBuffer(bytes);
      if (!detected?.mime.startsWith("video/")) return { ok: false, detail: "视频文件损坏或格式无效" };
    }
    return { ok: true };
  } catch {
    return { ok: false, detail: kind === "audio" ? "语音文件不存在或无法读取" : "媒体文件不存在或无法读取" };
  }
}

function classroomMediaReferences(classroom: PersistedClassroomData): Array<{
  sceneId: string;
  elementId: string;
  type: "image" | "video";
  url: string;
}> {
  return classroom.scenes.flatMap((scene) => {
    if (scene.type !== "slide" || scene.content?.type !== "slide") return [];
    return (scene.content.canvas.elements ?? []).flatMap((element) => (
      (element.type === "image" || element.type === "video") && !isMediaPlaceholder(element.src || "")
        ? [{ sceneId: scene.id, elementId: element.id, type: element.type, url: element.src || "" }]
        : []
    ));
  });
}

async function auditClassroomFiles(
  classroom: PersistedClassroomData,
  cache: Map<string, Promise<ResourceIntegrity>>,
): Promise<{ tts: CourseResourceIssue[]; media: CourseResourceIssue[] }> {
  const check = (url: string, kind: "audio" | "image" | "video") => {
    const key = `${kind}:${url}`;
    const pending = cache.get(key) ?? checkResourceIntegrity(url, kind);
    cache.set(key, pending);
    return pending;
  };
  const tts = (await Promise.all(classroom.scenes.flatMap((scene) => (
    (scene.actions ?? []).flatMap((action) => (
      action.type === "speech" && action.text.trim() && action.audioUrl
        ? [check(action.audioUrl, "audio").then((result): CourseResourceIssue | null => result.ok ? null : ({
            id: `tts:${scene.id}:${action.id}`,
            type: "tts",
            title: userFacingName(scene.title, "课程讲解页面"),
            detail: result.detail,
          }))]
        : []
    ))
  )))).filter((issue): issue is CourseResourceIssue => Boolean(issue));
  const media = (await Promise.all(classroomMediaReferences(classroom).map((reference) => (
    check(reference.url, reference.type).then((result): CourseResourceIssue | null => result.ok ? null : ({
      id: `media:${reference.type}:${reference.elementId}`,
      type: "media",
      title: reference.type === "image" ? "课程图片" : "课程视频",
      detail: result.detail,
    }))
  )))).filter((issue): issue is CourseResourceIssue => Boolean(issue));
  return { tts, media };
}

async function auditRequiredTextbookImages(
  course: Course,
  outlines: NonNullable<Course["content"]["_openmaicSceneOutlines"]>,
  classroom: PersistedClassroomData,
): Promise<CourseResourceIssue[]> {
  const pages = course.content.teachingBlueprint?.sections.flatMap((section) => section.pages) ?? [];
  const required = pages.flatMap((page) => (page.resourceNeeds ?? []).flatMap((need) => (
    need.required && need.kind === "source-image" && need.assetId
      ? [{ page, need }]
      : []
  )));
  if (!required.length) return [];

  const figureIds = [...new Set(course.content.courseEvidence?.items.flatMap((item) => (
    item.figureRefs?.map((reference) => reference.figureId) ?? item.figureIds ?? []
  )) ?? [])];
  const figures = figureIds.length ? await prisma.textbookFigure.findMany({
    where: { id: { in: figureIds } },
    select: { id: true, fileAssetId: true, status: true },
  }) : [];
  const figureByResourceId = new Map(figures.map((figure) => [
    `textbook_fig_${createHash("sha256").update(figure.id).digest("hex").slice(0, 12)}`,
    figure,
  ]));
  const outlineIdsByParent = new Map<string, Set<string>>();
  for (const outline of outlines) {
    const parentId = typeof outline.spatialParentId === "string" && outline.spatialParentId
      ? outline.spatialParentId : outline.id;
    const ids = outlineIdsByParent.get(parentId) ?? new Set<string>();
    ids.add(outline.id);
    outlineIdsByParent.set(parentId, ids);
  }

  return required.flatMap(({ page, need }): CourseResourceIssue[] => {
    const outlineIds = outlineIdsByParent.get(page.outlineId ?? page.id);
    // Missing pages are handled by the content review. This also keeps a
    // single-section test from auditing resource plans outside its scope.
    if (!outlineIds?.size) return [];
    const pageScenes = classroom.scenes.filter((scene) => outlineIds.has(scene.outlineId ?? scene.id));
    if (!pageScenes.length) return [];
    const figure = figureByResourceId.get(need.assetId!);
    const expectedSrc = figure ? `${UPLOAD_MEDIA_PREFIX}${figure.fileAssetId}` : undefined;
    const present = expectedSrc && pageScenes.some((scene) => scene.content?.type === "slide"
      && scene.content.canvas.elements.some((element) => element.type === "image"
        && element.src === expectedSrc));
    if (present && figure?.status === "AVAILABLE") return [];
    return [{
      id: `media:source-image:${page.id}:${need.assetId}`,
      type: "media",
      title: "指定教材图片",
      detail: !figure || figure.status !== "AVAILABLE"
        ? "绑定的教材原图记录不可用"
        : "指定的教材原图未进入对应课堂页面",
    }];
  });
}

export async function auditCourseGeneratedResources(
  courseId: string,
  snapshot?: CourseResourceAuditSnapshot,
): Promise<{
  classroomId?: string;
  issues: CourseResourceIssue[];
}> {
  const course = snapshot?.course ?? await getCourse(courseId);
  if (!course) return { issues: [] };
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const classroom = snapshot?.classroom ?? (classroomId ? await readClassroom(classroomId) : null);
  const classroomIssues: CourseResourceIssue[] = !classroomId
    ? [{
        id: "classroom:missing",
        type: "classroom",
        title: "课程课堂文件",
        detail: "课程课堂尚未生成",
      }]
    : !classroom
      ? [{
          id: `classroom:${classroomId}`,
          type: "classroom",
          title: "课程课堂文件",
          detail: "课堂文件尚未持久化，需要自动恢复",
        }]
      : classroom.scenes.length === 0
        ? [{
            id: `classroom:${classroomId}:empty`,
            type: "classroom",
            title: "课程课堂文件",
            detail: "课堂没有可播放页面，需要重新生成",
          }]
        : [];
  const outlines = snapshot
    ? course.content._openmaicSceneOutlines ?? []
    : await resolveDurableCourseSceneOutlines(courseId, course.content._openmaicSceneOutlines ?? []);
  const toolIssues = classroom
    ? findMissingTeachingToolResources(outlines, classroom.scenes).map((issue) => ({
        id: `tool:${issue.outlineId}:${issue.tool}`,
        type: "teaching-tool" as const,
        title: userFacingName(issue.title, "课程教学工具"),
        detail: `${issue.tool === "whiteboard" ? "白板" : "教学工具"}计划动作未生成`,
      }))
    : [];
  const ttsIssues = classroom
    ? findMissingTtsResources(classroom.scenes).map((issue) => ({
        id: `tts:${issue.sceneId}:${issue.actionId}`,
        type: "tts" as const,
        title: userFacingName(issue.title, "课程讲解页面"),
        detail: "配置语音未生成",
      }))
    : [];
  const speechSyncIssues = classroom
    ? classroom.scenes.flatMap((scene) => {
        const speech = (scene.actions ?? []).filter((action) => (
          action.type === "speech" && Boolean(action.text.trim()) && Boolean(action.audioUrl)
        ));
        const unresolved = speech.filter((action) => (
          action.type === "speech" && (
            action.speechAlignment?.status !== "aligned" || Boolean(action.speechAlignment.error)
          )
        ));
        if (!unresolved.length) return [];
        const failed = unresolved.filter((action) => (
          action.type === "speech" && action.speechAlignment?.status === "failed"
        )).length;
        const bindingWarning = unresolved.find((action) => (
          action.type === "speech"
          && action.speechAlignment?.status === "aligned"
          && action.speechAlignment.error
        ));
        return [{
          id: `speech-sync:${scene.id}`,
          type: "speech-sync" as const,
          title: userFacingName(scene.title, "课程讲解页面"),
          detail: bindingWarning?.type === "speech" && bindingWarning.speechAlignment?.error
            ? bindingWarning.speechAlignment.error
            : failed > 0
            ? `${failed} 段语音对齐失败，按音频同步的字幕定位与指示动作已停用`
            : `${unresolved.length} 段语音尚未建立字幕与动作的音频时间线`,
        }];
      })
    : [];
  const classroomReads = new Map<string, Promise<PersistedClassroomData | null>>();
  if (classroomId && classroom) classroomReads.set(classroomId, Promise.resolve(classroom));
  const resourceChecks = new Map<string, Promise<ResourceIntegrity>>();
  const mainFileIssues = classroom
    ? await auditClassroomFiles(classroom, resourceChecks)
    : { tts: [], media: [] };
  const textbookImageIssues = classroom
    ? await auditRequiredTextbookImages(course, outlines, classroom)
    : [];
  const adaptiveIssues: CourseResourceIssue[] = [];
  if (course.content.classroomGenerationRun?.scope !== "test-lesson"
    && course.content.adaptiveLearningPlan?.enabled) {
    for (const branch of course.content.adaptiveLearningPlan.branches) {
      if (branch.enabled === false || branch.status !== "teacher-confirmed") continue;
      const prepared = branch.preparedResource;
      const title = userFacingName(branch.title, "个性化学习资源");
      if (prepared?.status !== "ready" || !prepared.classroomId || !isValidClassroomId(prepared.classroomId)) {
        adaptiveIssues.push({
          id: `adaptive:${branch.id}`,
          type: "adaptive-resource",
          title,
          detail: prepared?.status === "failed" ? "资源生成未完成，请重新生成" : "个性化学习资源尚未生成",
        });
        continue;
      }
      const pending = classroomReads.get(prepared.classroomId) ?? readClassroom(prepared.classroomId);
      classroomReads.set(prepared.classroomId, pending);
      const adaptiveClassroom = await pending;
      if (!adaptiveClassroom || adaptiveClassroom.scenes.length === 0) {
        adaptiveIssues.push({
          id: `adaptive:${branch.id}`,
          type: "adaptive-resource",
          title,
          detail: "个性化学习课堂不存在或没有可播放页面",
        });
        continue;
      }
      const adaptiveFiles = await auditClassroomFiles(adaptiveClassroom, resourceChecks);
      const missingTts = findMissingTtsResources(adaptiveClassroom.scenes);
      const unresolvedMedia = findUnresolvedClassroomMedia([], adaptiveClassroom.scenes);
      if (missingTts.length || adaptiveFiles.tts.length || adaptiveFiles.media.length || unresolvedMedia.length) {
        adaptiveIssues.push({
          id: `adaptive:${branch.id}`,
          type: "adaptive-resource",
          title,
          detail: "个性化学习课堂仍有语音或媒体资源未就绪",
        });
      }
    }
  }
  const unresolvedMedia = classroom
    ? findUnresolvedClassroomMedia(outlines, classroom.scenes)
    : [];
  // Generation diagnostics describe an earlier attempt. Once the slide no
  // longer references that placeholder, only the current asset matters.
  const mediaIssues = unresolvedMedia.flatMap((failure) =>
    failure.type === "image" || failure.type === "video"
      ? [{
          id: `media:${failure.type}:${failure.elementId}`,
          type: "media" as const,
          title: failure.type === "image" ? "课程图片" : "课程视频",
          detail: `${failure.type === "image" ? "图片" : "视频"}生成未完成，请重新生成`,
        }]
      : [],
  );
  const dedupe = (issues: CourseResourceIssue[]) => Array.from(new Map(
    issues.map((issue) => [issue.id, issue]),
  ).values());
  return {
    classroomId,
    issues: dedupe([
      ...classroomIssues,
      ...adaptiveIssues,
      ...toolIssues,
      ...ttsIssues,
      ...mainFileIssues.tts,
      ...speechSyncIssues,
      ...mediaIssues,
      ...textbookImageIssues,
      ...mainFileIssues.media,
    ]),
  };
}
