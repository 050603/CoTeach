// Server-side session store.
//
// When DATABASE_URL is configured, delegates to the PostgreSQL repository
// (src/lib/db/session-repository.ts) for persistence and concurrency control.
// When DATABASE_URL is missing (demo mode), falls back to the JSON file store
// with the original process-level promise chain. A startup warning is logged
// so operators know to migrate.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { applySessionAction, initialSessionState } from "./actions";
import type { SessionAction, SessionState } from "./actions";
import type { Course } from "./types";
import { normalizeReflectionContent } from "@/lib/reflection-survey";
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  loadSessionState as dbLoadSessionState,
  loadCourse as dbLoadCourse,
  saveCourse as dbSaveCourse,
  deleteCourse as dbDeleteCourse,
  dispatchAction as dbDispatchAction,
  updateCourse as dbUpdateCourse,
} from "@/lib/db/session-repository";
import { buildPatch } from "@/lib/realtime/patch-builder";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { applyCourseUpdate } from "@/lib/session/course-update";
import { persistCourseUpdateInvalidation } from "@/lib/realtime/course-update-invalidation";

/**
 * Push an invalidation event after persistence succeeds. Redis forwards it
 * across instances when configured; local subscribers are notified directly.
 */
function maybePublishRealtimePatch(
  before: SessionState,
  after: SessionState,
  action: SessionAction,
): void {
  try {
    const patch = buildPatch(before, after, action);
    if (!patch.courseId || patch.events.length === 0) return;
    for (const event of patch.events) {
      void publishCourseEvent(patch.courseId, event).catch((error) => {
        console.error("[server-store] realtime publish failed:", error);
      });
    }
  } catch (err) {
    // Realtime publishing must never break the persistence flow.
    console.error("[server-store] realtime publish failed:", err);
  }
}

/**
 * Variant of the above for `updateCourse` callers: we don't have a
 * SessionAction here, so we synthesise a generic course-updated event.
 */
function maybePublishCourseUpdated(
  courseId: string,
  updatedAt: string,
): void {
  if (!courseId) return;
  try {
    void publishCourseEvent(courseId, {
        type: "course-updated",
        courseId,
        at: updatedAt,
      })
      .catch((error) => {
        console.error("[server-store] realtime publish failed:", error);
      });
  } catch (err) {
    console.error("[server-store] realtime publish failed:", err);
  }
}

const DATA_DIR = path.join(process.cwd(), ".openpbl-data");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const WRITE_RETRIES = 6;
const WRITE_RETRY_DELAY_MS = 80;

let databaseModeWarned = false;

function warnIfDemoMode() {
  if (!isDatabaseConfigured() && !databaseModeWarned) {
    console.warn(
      "[server-store] DATABASE_URL not configured — falling back to JSON file store. " +
        "This is fine for local development but not for production. " +
        "Configure the V2 PostgreSQL database before using platform accounts or collecting classroom evidence.",
    );
    databaseModeWarned = true;
  }
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function emptyPersistedState(): SessionState {
  return {
    ...initialSessionState(),
    courses: [],
    hydrated: true,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// JSON file implementation (demo mode fallback)
// ---------------------------------------------------------------------------

async function readJsonState(): Promise<SessionState> {
  await ensureDataDir();

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 50;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const raw = await readFile(SESSION_FILE, "utf8");
      // Detect the post-migration marker file — treat as empty state
      if (raw.trim().startsWith("{") && raw.includes('"migrated": true')) {
        return emptyPersistedState();
      }
      const parsed = JSON.parse(raw) as SessionState;
      return {
        ...emptyPersistedState(),
        ...parsed,
        hydrated: true,
        courses: parsed.courses ?? [],
      };
    } catch (err) {
      if (!existsSync(SESSION_FILE)) {
        const initial = emptyPersistedState();
        await writeJsonState(initial);
        return initial;
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      console.error("[server-store] readJsonState exhausted retries:", err);
      throw err;
    }
  }

  return emptyPersistedState();
}

async function writeJsonState(state: SessionState): Promise<void> {
  await ensureDataDir();
  const payload = JSON.stringify({ ...state, hydrated: true }, null, 2);
  const tmpFile = path.join(
    DATA_DIR,
    `session.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tmpFile, payload, "utf8");
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      try {
        await rename(tmpFile, SESSION_FILE);
        return;
      } catch (err) {
        if (attempt === WRITE_RETRIES - 1) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, WRITE_RETRY_DELAY_MS * (attempt + 1)),
        );
      }
    }
  } finally {
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

// Process-level promise chain for serialising JSON file writes.
let actionChain: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// Public API — transparently routes to DB or JSON file
// ---------------------------------------------------------------------------

export async function readSessionState(): Promise<SessionState> {
  if (isDatabaseConfigured()) {
    return dbLoadSessionState();
  }
  warnIfDemoMode();
  return readJsonState();
}

export async function writeSessionState(state: SessionState): Promise<void> {
  if (isDatabaseConfigured()) {
    // Persistence happens via saveCourse in dispatchAction / updateCourse.
    // Direct full-state writes are not supported in DB mode — calling this
    // is a no-op (the assumption is that dispatchAction or updateCourse was
    // already called to mutate state).
    return;
  }
  warnIfDemoMode();
  await writeJsonState(state);
}

export async function dispatchSessionAction(
  action: SessionAction,
): Promise<SessionState> {
  if (isDatabaseConfigured()) {
    const before = await dbLoadSessionState();
    const after = await dbDispatchAction(action);
    maybePublishRealtimePatch(before, after, action);
    return after;
  }
  warnIfDemoMode();

  const run = async (): Promise<SessionState> => {
    const current = await readJsonState();
    const next = applySessionAction(current, action);
    await writeJsonState(next);
    maybePublishRealtimePatch(current, next, action);
    return next;
  };

  const result = actionChain.then(run);
  actionChain = result.catch(() => undefined);
  return result;
}

export async function getCourse(courseId: string): Promise<Course | undefined> {
  if (isDatabaseConfigured()) {
    return dbLoadCourse(courseId);
  }
  warnIfDemoMode();
  const state = await readJsonState();
  const course = state.courses.find((c) => c.id === courseId);
  if (!course) return undefined;
  return {
    ...course,
    reflections: (course.reflections ?? []).map((reflection) => {
      const normalized = normalizeReflectionContent(
        (reflection as unknown as { content?: unknown }).content,
      );
      return {
        ...reflection,
        content: normalized.content,
        improvementPlan: normalized.improvementPlan ?? reflection.improvementPlan,
        survey: normalized.survey ?? reflection.survey,
      };
    }),
  };
}

export async function updateCourse(
  courseId: string,
  updater: (course: Course) => Course,
  invalidation: { targetStudentId?: string; actor?: { id: string; role: string } } = {},
): Promise<SessionState> {
  if (isDatabaseConfigured()) {
    const after = await dbUpdateCourse(courseId, updater, invalidation.actor);
    const course = after.courses.find((candidate) => candidate.id === courseId);
    if (!course) throw new Error(`Course not found after update: ${courseId}`);
    await persistCourseUpdateInvalidation({
      courseId,
      courseVersion: course.version ?? 1,
      updatedAt: course.updatedAt ?? after.updatedAt ?? new Date().toISOString(),
      targetStudentId: invalidation.targetStudentId,
    });
    return after;
  }
  warnIfDemoMode();

  const run = async (): Promise<SessionState> => {
    const current = await readJsonState();
    const updatedAt = new Date().toISOString();
    const courses = current.courses.map((c) =>
      c.id === courseId ? applyCourseUpdate(c, updater, updatedAt) : c,
    );
    const next: SessionState = {
      ...current,
      courses,
      updatedAt,
    };
    await writeJsonState(next);
    maybePublishCourseUpdated(courseId, next.updatedAt ?? new Date().toISOString());
    return next;
  };
  const result = actionChain.then(run);
  actionChain = result.catch(() => undefined);
  return result;
}

// Re-export DB-specific operations for callers that need them directly
// (e.g. course restart flow in stage 2).
export {
  dbSaveCourse as saveCourseToDb,
  dbDeleteCourse as deleteCourseFromDb,
  dbLoadCourse as loadCourseFromDb,
  dbLoadSessionState as loadSessionStateFromDb,
  dbDispatchAction as dispatchActionToDb,
  dbUpdateCourse as updateCourseInDb,
};
