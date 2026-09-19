export const V5_PIPELINE_VERSION = "course-quality-lab-v5-first-pass-v10";

export const V5_MODULE_CONTRACTS = {
  plan: {
    version: "first-pass-teaching-contract-v2",
    dependencies: [],
  },
  slides: {
    version: "explicit-semantic-slide-v2",
    dependencies: ["plan"],
  },
  narration: {
    version: "role-aware-narration-v2",
    dependencies: ["plan"],
  },
  actions: {
    version: "explicit-action-binding-v2",
    dependencies: ["slides", "narration"],
  },
  review: {
    version: "single-page-repair-review-v2",
    dependencies: ["plan", "slides", "narration", "actions"],
  },
  quiz: {
    version: "taught-content-quiz-v1",
    dependencies: ["narration", "review"],
  },
  audio: {
    version: "segment-audio-v1",
    dependencies: ["narration", "review"],
  },
  export: {
    version: "course-export-v1",
    // Export intentionally does not depend on audio, so both can proceed once
    // their own prerequisites are ready.
    dependencies: ["slides", "actions", "quiz", "review"],
  },
} as const;

export type V5ModuleName = keyof typeof V5_MODULE_CONTRACTS;
