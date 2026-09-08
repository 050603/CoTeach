import type { Course, StageViewKey } from "@/lib/session/types";
import { AiLearningView } from "./ai-learning";
import { NewReflectionStudentView } from "./reflection-survey";
import { SimplifiedStudentStageView } from "@/components/classroom/simple-stage-resources";
import { NewShowcaseStudentView } from "./showcase-reporting";

export function StudentStageView({
  view,
  course,
}: {
  view: StageViewKey;
  course: Course;
  embedded?: boolean;
}) {
  const currentStage = course.stages[course.currentStageIndex];
  const normalizedView = view === "simple-resource"
    && currentStage?.key === "showcase"
    ? "showcase-reporting"
    : view === "simple-resource"
      && currentStage?.key === "reflection"
      ? "reflection-survey"
    : view;
  switch (normalizedView) {
    case "ai-learning":
      return <AiLearningView course={course} />;
    case "simple-resource":
      return (
        <SimplifiedStudentStageView
          course={course}
          stageKey={course.stages[course.currentStageIndex]?.key ?? "launch"}
        />
      );
    case "showcase-reporting":
      return <NewShowcaseStudentView course={course} />;
    case "reflection-survey":
      return <NewReflectionStudentView course={course} />;
    default:
      return (
        <SimplifiedStudentStageView
          course={course}
          stageKey={currentStage?.key ?? "launch"}
        />
      );
  }
}
