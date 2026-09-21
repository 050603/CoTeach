"use client";

import { useMemo } from "react";
import { aggregateKnowledgePointMastery } from "@/lib/knowledge-lecture";
import type { Course } from "@/lib/session/types";
import { PublicDiscussionTeacherPanel } from "./public-discussion-panel";

export function PublicDiscussionTeacherWorkspace({
  course,
  hidden = false,
}: {
  course: Course;
  hidden?: boolean;
}) {
  const recommendedKnowledgePointIds = useMemo(
    () => aggregateKnowledgePointMastery(course, course.aiLearningProgress ?? {})
      .filter((row) => row.status === "confirmed")
      .slice(0, 4)
      .map((row) => row.knowledgePointId),
    [course],
  );

  return (
    <section
      aria-label="AI 公开讨论工作台"
      className="teacher-presentation-content h-full min-h-0"
      hidden={hidden}
    >
      <PublicDiscussionTeacherPanel
        course={course}
        immersive
        recommendedKnowledgePointIds={recommendedKnowledgePointIds}
      />
    </section>
  );
}
