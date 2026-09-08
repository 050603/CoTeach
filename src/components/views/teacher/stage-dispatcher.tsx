import type { Course, StageViewKey } from "@/lib/session/types";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import type { ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import { AiLearningTeacherView } from "./ai-learning";
import { NewReflectionTeacherView } from "./reflection-survey";
import { SimplifiedTeacherStageView } from "@/components/classroom/simple-stage-resources";
import { AiCollaborationTeacherMonitor } from "./ai-collaboration-monitor";
import { NewShowcaseTeacherView } from "./showcase-reporting";

/**
 * Teacher-side stage view dispatcher.
 * Renders a different UI per stage, focused on:
 *  - 课堂整体进度
 *  - 需关注的学生
 *  - 切换查看各组作品/方案
 *  - 实时打分与评价
 */
export function TeacherStageView({
  view,
  course,
  onSelectStudent,
  focus,
  showcaseController,
}: {
  view: StageViewKey;
  course: Course;
  onSelectStudent?: (studentId: string) => void;
  focus?: TeacherStageFocus;
  showcaseController?: ShowcasePresentationController;
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
      return (
        <AiLearningTeacherView
          course={course}
          onSelectStudent={onSelectStudent}
          focus={focus?.stageKey === "ai-learning" ? focus : undefined}
        />
      );
    case "simple-resource":
      return (
        <SimplifiedTeacherStageView
          course={course}
          stageKey={course.stages[course.currentStageIndex]?.key ?? "launch"}
          focus={focus?.stageKey === "launch" ? focus : undefined}
        />
      );
    case "ai-collaboration":
      return <AiCollaborationTeacherMonitor course={course} focus={focus?.stageKey === "make" ? focus : undefined} />;
    case "showcase-reporting":
      return <NewShowcaseTeacherView course={course} focus={focus?.stageKey === "showcase" ? focus : undefined} controller={showcaseController} />;
    case "reflection-survey":
      return <NewReflectionTeacherView course={course} focus={focus?.stageKey === "reflection" ? focus : undefined} />;
    default:
      return (
        <SimplifiedTeacherStageView
          course={course}
          stageKey={currentStage?.key ?? "launch"}
          focus={focus?.stageKey === "launch" ? focus : undefined}
        />
      );
  }
}
