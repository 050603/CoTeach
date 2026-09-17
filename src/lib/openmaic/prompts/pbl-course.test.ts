import { describe, expect, it } from "vitest";
import { DEFAULT_PBL_COURSE_CONFIG, formatPblCourseConfigForPrompt } from "@/lib/pbl-course-config";
import { formatPblStageDefinitionsForPrompt } from "@/lib/openmaic/pbl/course-template";
import { buildPrompt, PROMPT_IDS } from "./index";

describe("PBL course prompt", () => {
  it("loads the six-stage contract and structured teacher configuration", () => {
    const prompt = buildPrompt(PROMPT_IDS.PBL_COURSE, {
      requirement: "课程：校园节能设计；驱动问题：如何减少浪费？",
      pblProfile: formatPblCourseConfigForPrompt({
        ...DEFAULT_PBL_COURSE_CONFIG,
        outcome: {
          artifact: "节能方案",
          presentation: "个人答辩",
          reflection: "成长反思",
        },
      }),
      pblStages: formatPblStageDefinitionsForPrompt(),
      requiredTeacherResourceStages: "launch, showcase",
      teacherContext: "教师负责线下校准与成果评价。",
      researchContext: "None",
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.system).toContain("exactly six phases");
    expect(prompt?.system).toContain("personal-project classroom");
    expect(prompt?.system).toContain("stageKey");
    expect(prompt?.system).toContain("audience");
    expect(prompt?.system).toContain("parentActivityId");
    expect(prompt?.system).toContain("targetDurationSec");
    expect(prompt?.system).toContain("one semantic PPT page");
    expect(prompt?.system).toContain("fixed seconds-per-page rule");
    expect(prompt?.system).toContain("companionStagePolicies[stageKey]");
    expect(prompt?.system).toContain("reflection");
    expect(prompt?.system).toContain("exactly one concise `quiz`");
    expect(prompt?.user).toContain("节能方案");
    expect(prompt?.user).toContain("companionStagePolicies");
    expect(prompt?.user).toContain("launch, showcase");
    expect(prompt?.user).toContain("one coherent PPT page");
    expect(prompt?.user).toContain("fixed seconds-per-page threshold");
    expect(prompt?.user).toContain("教师负责线下校准与成果评价");
    expect(prompt?.user).toContain("End every completed knowledge section");
    expect(prompt?.user).toContain("at least one brief objective question for every taught knowledge point");
    expect(prompt?.user).toContain("constructed-response mode");
    expect(prompt?.user).toContain("knowledgePointIds");
  });

  it("injects distinct dynamic strategies for standard and deep-interaction modes", () => {
    const common = {
      requirement: "课程：校园节能设计",
      pblProfile: formatPblCourseConfigForPrompt(DEFAULT_PBL_COURSE_CONFIG),
      pblStages: formatPblStageDefinitionsForPrompt(),
      requiredTeacherResourceStages: "launch, proposal, make, showcase, reflection",
      teacherContext: "",
      researchContext: "None",
    };

    const normal = buildPrompt(PROMPT_IDS.PBL_COURSE, {
      ...common,
      standardMode: true,
      deepInteractionMode: false,
    });
    const interactive = buildPrompt(PROMPT_IDS.PBL_COURSE, {
      ...common,
      standardMode: false,
      deepInteractionMode: true,
    });

    expect(normal?.user).toContain("Standard mode strategy");
    expect(normal?.user).toContain("A coherent slide-and-quiz sequence is valid");
    expect(normal?.user).not.toContain("Deep-interaction mode strategy");
    expect(interactive?.user).toContain("Deep-interaction mode strategy");
    expect(interactive?.user).toContain("There are no widget-type quotas");
    expect(interactive?.user).not.toContain("Standard mode strategy");
    expect(interactive?.user).toContain("its concept, a concrete example");
    expect(interactive?.user).toContain("Interactions are ungraded exploration or operation spaces");
    expect(interactive?.user).toContain("matching, sorting, ordering, drag-to-answer");
    expect(interactive?.user).toContain("PPT/script-only");
    expect(interactive?.user).toContain("Decorative clicking");
    expect(interactive?.user).toContain("do not force a fixed number of pages");
  });
});
