import type { Course } from "@/lib/session/types";

export type CourseCoverContext = Pick<Course, "name"> &
  Partial<
    Pick<
      Course,
      "subject" | "grade" | "summary" | "drivingQuestion" | "expectedOutcome" | "learningObjectives"
    >
  > & {
    term?: string;
    outline?: string;
    /** Platform offerings summarize a course; preparation covers depict one lesson. */
    coverKind?: "course" | "classroom";
    content?: Partial<Pick<Course["content"], "teachingOutline" | "lessonOutline" | "pblOutline" | "knowledgePoints">>;
  };

/** Only sceneDescription crosses into the image request; the rationale stays with the planner. */
export type CourseCoverVisualPlan = {
  topicSummary: string;
  visualAnchor: string;
  sceneDescription: string;
};

const COVER_STYLE = "contemporary educational editorial illustration, gouache texture, natural forms";

/**
 * All course covers share this output contract. Keeping the dimensions and art
 * direction here prevents individual preparation screens from drifting into
 * different ratios or unrelated visual styles.
 */
export const COURSE_COVER_GENERATION_SPEC = {
  aspectRatio: "16:9" as const,
  width: 1280,
  height: 720,
  style: COVER_STYLE,
  promptExtend: false,
  negativePrompt:
    "text, pseudo text, handwriting, printed lines, open book, printed page, letters, numbers, formulas, typography, labels, captions, title, logo, watermark, signature, UI, QR code, poster layout, collage, split panels, icon cloud, clutter, unrelated props, generic AI brain, neon glow, sci-fi, anime, chibi, cartoon mascot, photorealism, 3D render, plastic texture, crowd, group portrait, impossible geometry, inconsistent perspective",
};

/** Accept a validated visual plan, never raw course content or planning instructions. */
export function buildCourseCoverPrompt(
  plan: CourseCoverVisualPlan,
): string {
  return [
    plan.sceneDescription,
    "Contemporary educational editorial illustration with fine gouache on matte paper, natural proportions and soft daylight. Calm warm-white and pale blue surroundings; preserve the subject's natural colors, with restrained teal and ochre accents.",
    "One continuous landscape scene, edge-to-edge artwork, a strong central focal point and crop-safe margins. Clear subject silhouettes at thumbnail size. All surfaces are unlettered. Absolutely no text, letters, numbers, labels, captions, logos, watermarks, title bands, panels or poster layout.",
    "Any books are closed with plain covers. No printed pages, worksheets or writing lines. Any necessary screen shows only large simple shapes, without an interface.",
  ].join("\n\n");
}

export async function requestCourseCoverImage(
  course: CourseCoverContext & Pick<Course, "id">,
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/cover`, {
    method: "POST",
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    coverImageUrl?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message || `封面生成失败（${response.status}）`);
  }
  return payload.coverImageUrl ?? null;
}

export async function uploadCourseCoverImage(
  courseId: string,
  file: File,
  signal?: AbortSignal,
): Promise<string | null> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/cover`, {
    method: "PUT",
    body: form,
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    coverImageUrl?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.message || `封面上传失败（${response.status}）`);
  }
  return payload.coverImageUrl ?? null;
}

export function courseCoverResultUrl(result: {
  url?: string;
  base64?: string;
  format?: string;
}): string | null {
  if (result.url) return result.url;
  if (result.base64) return `data:image/${result.format || "png"};base64,${result.base64}`;
  return null;
}
