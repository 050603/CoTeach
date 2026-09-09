import type { Course } from "@/lib/session/types";

export type CourseCoverContext = Pick<Course, "name"> &
  Partial<
    Pick<
      Course,
      "subject" | "grade" | "summary" | "drivingQuestion" | "expectedOutcome"
    >
  >;

const COVER_STYLE = "warm educational narrative illustration";

/**
 * All course covers share this output contract. Keeping the dimensions and art
 * direction here prevents individual preparation screens from drifting into
 * different ratios or unrelated visual styles.
 */
export const COURSE_COVER_GENERATION_SPEC = {
  aspectRatio: "16:9" as const,
  width: 1024,
  height: 576,
  style: COVER_STYLE,
  negativePrompt:
    "text, words, letters, numbers, typography, captions, labels, logos, watermarks, interface elements, posters, book covers, split panels, commercial advertising, cinematic key art, game concept art, neon science fiction, childish cartoon, mascot characters, exaggerated expressions, dark or threatening mood, photorealism, glossy 3D render, clutter, generic education icons, generic classroom backdrop",
};

function cleanContext(value: string | undefined, maxLength: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function buildCourseCoverPrompt(
  course: CourseCoverContext,
): string {
  const name = cleanContext(course.name, 100) || "Untitled project course";
  const subject = cleanContext(course.subject, 60);
  const grade = cleanContext(course.grade, 40);
  const drivingQuestion = cleanContext(course.drivingQuestion, 180);
  const summary = cleanContext(course.summary, 180);
  const expectedOutcome = cleanContext(course.expectedOutcome, 120);
  const roleContext = `${name} ${subject} ${grade} ${summary}`;
  const isTeacherEducationCourse = /(教学|教法|教育|pedagog|instructional)/i.test(roleContext)
    && /(大[一二三四]|大学|本科|师范|教师|college|university)/i.test(roleContext);

  const context = [
    `COURSE NAME: "${name}"`,
    drivingQuestion
      ? `CORE DRIVING QUESTION: "${drivingQuestion}"`
      : "CORE DRIVING QUESTION: Not provided. Keep the scene provisional and grounded in the course name instead of inventing an unrelated challenge.",
    subject ? `Subject: ${subject}` : null,
    grade ? `Learners: ${grade}` : null,
    summary ? `Course context: ${summary}` : null,
    expectedOutcome ? `Expected project outcome: ${expectedOutcome}` : null,
  ].filter(Boolean);

  return [
    "SCENE BRIEF: Treat the COURSE NAME and CORE DRIVING QUESTION as two equally binding inputs. The course name defines the project subject; the driving question turns it into people, place, concrete challenge, visible action and intended change. Build one specific, believable situation that satisfies both inputs. Never illustrate the title alone and never replace the project situation with generic books, classrooms, light bulbs, graduation symbols or abstract technology imagery.",
    context.join("\n"),
    "ROLE ACCURACY: Distinguish the actual course learners from any younger learners, clients or communities they are preparing to serve. For teacher-education, pedagogy or instructional-design courses, show the stated learners planning, rehearsing, observing or evaluating teaching—not the target school pupils merely using subject technology. Never turn a course about how to teach into a generic scene of students learning the subject.",
    isTeacherEducationCourse
      ? "MANDATORY TEACHER-EDUCATION SCENE: Depict adult university teacher candidates collaboratively designing and rehearsing an age-appropriate lesson. Make a lesson-plan storyboard, teaching-strategy cards, classroom-observation rubric and peer feedback the visible focus. Represent every document only through blank color blocks, simple lines and iconographic shapes—absolutely no writing, pseudo-writing or characters on paper, cards or boards. One adult may practice a micro-teaching gesture while peers evaluate the instructional design. NO children as the main learners, NO robot-building activity, NO coding screen as the focal point, and NO generic pupils merely using technology."
      : null,
    "STORY MOMENT: Silently infer who is affected, where the project takes place, what learners are trying to understand or improve, and what observable evidence or artifact would show progress. Depict one moment of age-appropriate learners, stakeholders or the project environment in action. Prefer learners investigating, making, testing or presenting a tangible response when that follows from the driving question. Every prominent object must help explain the project situation.",
    `ART DIRECTION: ${COVER_STYLE}; consistent PrAIxis course-cover visual system; suitable for display in a real school classroom—warm, calm, credible and inviting rather than commercial or spectacular; contemporary editorial gouache with clean shapes, lightly visible paper grain and natural human gestures; mature enough for the stated grade; restrained shared palette of chalkboard green, lake blue, terracotta and sunlit cream with small subject-specific accents; clear visual hierarchy and gentle daylight.`,
    "COMPOSITION: one believable project moment with a clear focal action, medium-low visual density, strong subject separation and generous breathing room; no montage, no split panels and no decorative icon cloud. Keep important subjects inside the central 80% so course-card crops remain legible. Reserve quieter negative space near the edges for interface overlays without drawing a fake title area.",
    "OUTPUT: 16:9 landscape composition at 1024x576. Pure image only. NO TEXT, NO WORDS, NO LETTERS, NO NUMBERS, NO TYPOGRAPHY, NO LABELS, NO CAPTIONS, NO LOGOS, NO WATERMARKS, NO UI.",
  ].filter(Boolean).join("\n\n");
}

export async function requestCourseCoverImage(
  course: CourseCoverContext,
  signal?: AbortSignal,
): Promise<string | null> {
  return requestCourseCoverImageAtEndpoint(course, "/api/openmaic/generate/image", signal);
}

export async function requestCourseCoverImageAtEndpoint(
  course: CourseCoverContext,
  endpoint: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: buildCourseCoverPrompt(course),
      ...COURSE_COVER_GENERATION_SPEC,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Image generation failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: { url?: string; base64?: string; format?: string };
  };
  const result = payload.result;
  if (result?.url) return result.url;
  if (result?.base64) {
    return `data:image/${result.format || "png"};base64,${result.base64}`;
  }
  return null;
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
